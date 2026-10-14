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
	if got := s.Properties["maybe"].Enum; !slices.Equal(got, []any{"x", nil}) {
		t.Errorf("enum = %v, want [x <nil>]", got)
	}
}

func TestInputSchemaDatePattern(t *testing.T) {
	s, err := InputSchema[sampleInput](nil)
	if err != nil {
		t.Fatalf("InputSchema: %v", err)
	}
	if day := s.Properties["day"]; day.Type != "string" || day.Pattern != coach.DatePattern {
		t.Errorf("day schema = type %q pattern %q", day.Type, day.Pattern)
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
