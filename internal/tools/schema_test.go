package tools

import (
	"slices"
	"testing"
)

type sampleInput struct {
	Kind  string `json:"kind" jsonschema:"what kind of item"`
	Notes string `json:"notes,omitempty"`
}

func TestInputSchemaAppliesEnums(t *testing.T) {
	s, err := InputSchema[sampleInput](map[string][]string{"kind": {"condition", "injury"}})
	if err != nil {
		t.Fatalf("InputSchema: %v", err)
	}
	got := s.Properties["kind"].Enum
	if !slices.Equal(got, []any{"condition", "injury"}) {
		t.Errorf("enum = %v", got)
	}
	if s.Properties["kind"].Description != "what kind of item" {
		t.Errorf("description lost: %q", s.Properties["kind"].Description)
	}
}

func TestInputSchemaRejectsUnknownProperty(t *testing.T) {
	if _, err := InputSchema[sampleInput](map[string][]string{"missing": {"x"}}); err == nil {
		t.Fatal("expected error for enum on a property that does not exist")
	}
}

func TestMustInputSchemaPanicsOnBadEnum(t *testing.T) {
	if s := MustInputSchema[sampleInput](nil); s.Properties["kind"] == nil {
		t.Fatal("expected inferred kind property")
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for enum on unknown property")
		}
	}()
	MustInputSchema[sampleInput](map[string][]string{"missing": {"x"}})
}
