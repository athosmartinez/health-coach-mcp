// Package tools holds the MCP tool implementations and their shared helpers.
package tools

import (
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
)

// InputSchema infers the JSON schema of In and restricts the named string
// properties to the given values. The `jsonschema` struct tag only sets a
// description, so enums have to be patched onto the inferred schema here.
func InputSchema[In any](enums map[string][]string) (*jsonschema.Schema, error) {
	s, err := jsonschema.For[In](nil)
	if err != nil {
		return nil, fmt.Errorf("infer schema: %w", err)
	}
	for prop, values := range enums {
		ps, ok := s.Properties[prop]
		if !ok {
			return nil, fmt.Errorf("enum for unknown property %q", prop)
		}
		ps.Enum = make([]any, len(values))
		for i, v := range values {
			ps.Enum[i] = v
		}
	}
	return s, nil
}

// MustInputSchema is InputSchema for static tool definitions, where a failure
// is a programming error caught by the registration tests.
func MustInputSchema[In any](enums map[string][]string) *jsonschema.Schema {
	s, err := InputSchema[In](enums)
	if err != nil {
		panic(err)
	}
	return s
}
