package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// NoteKinds mirrors the schema CHECK on notes.kind.
var NoteKinds = []string{"insight", "decision", "checkin", "symptom"}

const (
	defaultNoteLimit = 50
	maxNoteLimit     = 200
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

// AddNote stores a note; the FTS index is updated by the notes_ai trigger.
func (s *Store) AddNote(ctx context.Context, n Note) (Note, error) {
	if strings.TrimSpace(n.Text) == "" {
		return Note{}, errors.New("note text is required")
	}
	if n.Tags == nil {
		n.Tags = []string{}
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
func (s *Store) SearchNotes(ctx context.Context, f NoteFilter) ([]Note, error) {
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
			return nil, err
		}
		where = append(where, "(n.related_date >= ? OR (n.related_date IS NULL AND n.created_at >= ?))")
		args = append(args, string(f.Since), start.UTC().Format(timeLayout))
	}
	from := "notes n"
	if q := ftsQuery(f.Query); q != "" {
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

	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT n.id, n.kind, n.text, n.tags, n.related_date, n.created_at FROM %s
		WHERE %s ORDER BY n.created_at DESC, n.id DESC LIMIT ?`, from, strings.Join(where, " AND ")), args...)
	if err != nil {
		return nil, ftsError(err)
	}
	defer rows.Close()
	out := []Note{}
	for rows.Next() {
		var (
			n             Note
			tags, related sql.NullString
			stamp         string
		)
		if err := rows.Scan(&n.ID, &n.Kind, &n.Text, &tags, &related, &stamp); err != nil {
			return nil, ftsError(err)
		}
		n.Tags = []string{}
		if tags.Valid {
			if err := json.Unmarshal([]byte(tags.String), &n.Tags); err != nil {
				return nil, fmt.Errorf("note %d tags: %w", n.ID, err)
			}
		}
		n.RelatedDate, n.CreatedAt = coach.LocalDate(related.String), parseStamp(stamp)
		out = append(out, n)
	}
	return out, ftsError(rows.Err())
}

// ftsQuery quotes every word as an FTS5 phrase so user text can never be read
// as query syntax (AND, NEAR, column filters, unbalanced quotes).
func ftsQuery(q string) string {
	words := strings.Fields(q)
	for i, w := range words {
		words[i] = `"` + strings.ReplaceAll(w, `"`, `""`) + `"`
	}
	return strings.Join(words, " ")
}

func ftsError(err error) error {
	if err != nil && strings.Contains(err.Error(), "fts5") {
		return coach.ToolError{Code: coach.CodeInvalidInput, Message: "the search text could not be parsed", Hint: "use plain words"}
	}
	return err
}
