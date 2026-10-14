package tools

import (
	"slices"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

type sampleInput struct {
	Kind  string          `json:"kind" jsonschema:"what kind of item"`
	Notes string          `json:"notes,omitempty"`
	Tags  []string        `json:"tags,omitempty"`
	Maybe *string         `json:"maybe,omitempty"`
	Count int             `json:"count,omitempty"`
	Day   coach.LocalDate `json:"day,omitempty"`
	Inner struct {
		Leaf string `json:"leaf"`
	} `json:"inner"`
}

func TestInputSchemaAppliesEnumToString(t *testing.T) {
	s, err := InputSchema[sampleInput](map[string][]string{"kind": {"condition", "injury"}})
	if err != nil {
		t.Fatalf("InputSchema: %v", err)
	}
	if got := s.Properties["kind"].Enum; !slices.Equal(got, []any{"condition", "injury"}) {
		t.Errorf("enum = %v", got)
	}
	if s.Properties["kind"].Description != "what kind of item" {
		t.Errorf("description lost: %q", s.Properties["kind"].Description)
	}
}

func TestInputSchemaAppliesEnumToListItems(t *testing.T) {
	s, err := InputSchema[sampleInput](map[string][]string{"tags": {"a", "b"}})
	if err != nil {
		t.Fatalf("InputSchema: %v", err)
	}
	tags := s.Properties["tags"]
	if tags.Enum != nil {
		t.Errorf("enum on the array itself rejects every list: %v", tags.Enum)
	}
	if !slices.Equal(tags.Items.Enum, []any{"a", "b"}) {
		t.Errorf("items enum = %v", tags.Items.Enum)
	}
}

func TestInputSchemaKeepsNullAllowedForPointers(t *testing.T) {
	s, err := InputSchema[sampleInput](map[string][]string{"maybe": {"x"}})
	if err != nil {
		t.Fatalf("InputSchema: %v", err)
	}
	if got := s.Properties["maybe"].Enum; !slices.Equal(got, []any{"x", nil, ""}) {
		t.Errorf("enum = %v, want [x <nil> \"\"] (optional: null and empty mean not set)", got)
	}
}

func TestInputSchemaDatePattern(t *testing.T) {
	s, err := InputSchema[sampleInput](nil)
	if err != nil {
		t.Fatalf("InputSchema: %v", err)
	}
	// Optional: the pattern also accepts "" and the type null ("not set").
	day := s.Properties["day"]
	if !slices.Equal(day.Types, []string{"null", "string"}) || day.Pattern != `^(?:\d{4}-\d{2}-\d{2})?$` {
		t.Errorf("optional day schema = types %v pattern %q", day.Types, day.Pattern)
	}
	type required struct {
		Day coach.LocalDate `json:"day"`
	}
	strict, err := InputSchema[required](nil)
	if err != nil {
		t.Fatal(err)
	}
	if d := strict.Properties["day"]; d.Type != "string" || d.Pattern != coach.DatePattern {
		t.Errorf("required day schema = type %q pattern %q, want the strict date", d.Type, d.Pattern)
	}
}

func TestInputSchemaRejectsBadEnums(t *testing.T) {
	cases := map[string]map[string][]string{
		"unknown property": {"missing": {"x"}},
		"nested path":      {"inner.leaf": {"x"}},
		"non-string":       {"count": {"1"}},
		"object":           {"inner": {"x"}},
		"empty values":     {"kind": {}},
	}
	for name, enums := range cases {
		if _, err := InputSchema[sampleInput](enums); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestInputSchemaRejectsUninferableTypes(t *testing.T) {
	type bad struct {
		C chan int `json:"c"`
	}
	if _, err := InputSchema[bad](nil); err == nil {
		t.Fatal("expected error for a type with no JSON schema")
	}
}

func TestMustInputSchema(t *testing.T) {
	if s := MustInputSchema[sampleInput](nil); s.Properties["kind"] == nil {
		t.Fatal("expected inferred kind property")
	}
}

func TestMustInputSchemaPanicsOnBadEnum(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for enum on unknown property")
		}
	}()
	MustInputSchema[sampleInput](map[string][]string{"missing": {"x"}})
}
