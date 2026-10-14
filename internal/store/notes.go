package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// NoteKinds mirrors the schema CHECK on notes.kind.
var NoteKinds = []string{"insight", "decision", "checkin", "symptom"}

const (
	defaultNoteLimit = 50
	maxNoteLimit     = 200
	maxNoteText      = 8 << 10
	maxTags          = 20
	maxTagLen        = 64
	maxQueryWords    = 32
)

// Note is a free-text coach note.
type Note struct {
	ID          int64           `json:"id"`
	Kind        string          `json:"kind"`
	Text        string          `json:"text"`
	Tags        []string        `json:"tags"`
	RelatedDate coach.LocalDate `json:"related_date,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
}

func (n Note) validate() error {
	if !slices.Contains(NoteKinds, n.Kind) {
		return invalid("kind must be one of %s", strings.Join(NoteKinds, ", "))
	}
	if strings.TrimSpace(n.Text) == "" || len(n.Text) > maxNoteText {
		return invalid("note text is required (max %d bytes)", maxNoteText)
	}
	if len(n.Tags) > maxTags {
		return invalid("at most %d tags", maxTags)
	}
	for _, t := range n.Tags {
		if t == "" || len(t) > maxTagLen {
			return invalid("tags must be 1 to %d characters", maxTagLen)
		}
	}
	if n.RelatedDate != "" {
		if _, err := coach.ParseDate(string(n.RelatedDate)); err != nil {
			return invalid("related_date must be YYYY-MM-DD")
		}
	}
	return nil
}

// AddNote stores a note; the FTS index is updated by the notes_ai trigger.
func (s *Store) AddNote(ctx context.Context, n Note) (out Note, err error) {
	defer wrapErr("add note", &err)
	if n.Tags == nil {
		n.Tags = []string{}
	}
	if err := n.validate(); err != nil {
		return Note{}, err
	}
	tags, err := json.Marshal(n.Tags)
	if err != nil {
		return Note{}, err
	}
	stamp := s.stamp()
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO notes (kind, text, tags, related_date, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
		n.Kind, n.Text, string(tags), nullString(string(n.RelatedDate)), stamp).Scan(&n.ID)
	if err != nil {
		return Note{}, err
	}
	n.CreatedAt = parseStamp(stamp)
	return n, nil
}

// NoteFilter narrows SearchNotes. Zero values mean "no filter".
type NoteFilter struct {
	Kind string
	// Since keeps notes whose related_date, or creation day when unset, is on or after it.
	Since coach.LocalDate
	// Loc is the zone used to turn Since into an instant for created_at (default UTC).
	Loc *time.Location
	// Query is free text; every word must appear (FTS5, words matched as phrases).
	Query string
	Limit int
}

// SearchNotes returns matching notes, newest first. A query FTS5 cannot parse
// is reported as an invalid_input ToolError.
func (s *Store) SearchNotes(ctx context.Context, f NoteFilter) (out []Note, err error) {
	defer wrapErr("search notes", &err)
	where := []string{"1 = 1"}
	var args []any
	if f.Kind != "" {
		where = append(where, "n.kind = ?")
		args = append(args, f.Kind)
	}
	if f.Since != "" {
		loc := f.Loc
		if loc == nil {
			loc = time.UTC
		}
		start, _, err := f.Since.Bounds(loc)
		if err != nil {
			return nil, invalid("since must be YYYY-MM-DD")
		}
		where = append(where, "(n.related_date >= ? OR (n.related_date IS NULL AND n.created_at >= ?))")
		args = append(args, string(f.Since), start.UTC().Format(timeLayout))
	}
	from := "notes n"
	q, err := ftsQuery(f.Query)
	if err != nil {
		return nil, err
	}
	if q != "" {
		from = "notes n JOIN notes_fts ON notes_fts.rowid = n.id"
		where = append(where, "notes_fts MATCH ?")
		args = append(args, q)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = defaultNoteLimit
	}
	limit = min(limit, maxNoteLimit)
	args = append(args, limit)

	// Only fixed fragments are interpolated; every value is a placeholder.
	// id is monotonic, so it orders by insertion even within one clock tick.
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT n.id, n.kind, n.text, n.tags, n.related_date, n.created_at FROM %s
		WHERE %s ORDER BY n.id DESC LIMIT ?`, from, strings.Join(where, " AND ")), args...)
	if err != nil {
		return nil, ftsError(err)
	}
	defer rows.Close()
	out = []Note{}
	for rows.Next() {
		var (
			n             Note
			tags, related sql.NullString
			stamp         stampCol
		)
		if err := rows.Scan(&n.ID, &n.Kind, &n.Text, &tags, &related, &stamp); err != nil {
			return nil, ftsError(err)
		}
		n.Tags = []string{}
		if tags.Valid {
			if err := json.Unmarshal([]byte(tags.String), &n.Tags); err != nil {
				return nil, fmt.Errorf("note %d: tags are corrupt", n.ID)
			}
		}
		n.RelatedDate, n.CreatedAt = coach.LocalDate(related.String), time.Time(stamp)
		out = append(out, n)
	}
	return out, ftsError(rows.Err())
}

// ftsQuery quotes every word as an FTS5 phrase so user text can never be read
// as query syntax (AND, NEAR, column filters, unbalanced quotes). NUL bytes
// are dropped: SQLite ends the string there and reports a syntax error.
func ftsQuery(q string) (string, error) {
	words := strings.Fields(strings.ReplaceAll(q, "\x00", ""))
	if len(words) > maxQueryWords {
		return "", invalid("search at most %d words", maxQueryWords)
	}
	for i, w := range words {
		words[i] = `"` + strings.ReplaceAll(w, `"`, `""`) + `"`
	}
	return strings.Join(words, " "), nil
}

func ftsError(err error) error {
	if err != nil && strings.Contains(err.Error(), "fts5") {
		return coach.ToolError{Code: coach.CodeInvalidInput, Message: "the search text could not be parsed", Hint: "use plain words"}
	}
	return err
}
