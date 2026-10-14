// Package tools holds the MCP tool implementations and their shared helpers.
package tools

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// schemaOptions maps domain types to schemas that carry their validation, so the
// client sees the constraint before calling (UnmarshalText still enforces it).
var schemaOptions = &jsonschema.ForOptions{
	TypeSchemas: map[reflect.Type]*jsonschema.Schema{
		reflect.TypeFor[coach.LocalDate](): {
			Type:        "string",
			Pattern:     coach.DatePattern,
			Description: "Local calendar day, YYYY-MM-DD",
		},
		// Raw JSON and `any` accept any JSON value. Spelled as an object with a
		// description, not {}: {} serializes as the boolean schema `true`, which
		// some clients (zod-based, e.g. the MCP Inspector) reject in properties.
		// Inferred from its Go type, json.RawMessage would be a byte array.
		reflect.TypeFor[json.RawMessage](): anyJSON(),
		reflect.TypeFor[any]():             anyJSON(),
	},
}

func anyJSON() *jsonschema.Schema { return &jsonschema.Schema{Description: "any JSON value"} }

// OutputSchema infers the schema of a tool result with the same domain
// schemas as inputs. The SDK's own inference does not know them.
func OutputSchema[Out any]() (*jsonschema.Schema, error) {
	s, err := jsonschema.For[Out](schemaOptions)
	if err != nil {
		return nil, fmt.Errorf("infer output schema: %w", err)
	}
	return s, nil
}

// InputSchema infers the JSON schema of In and restricts the named top-level
// properties to the given values. The `jsonschema` struct tag only sets a
// description, so enums have to be patched onto the inferred schema here.
// A property may be a string, a nullable string (*string, where null stays
// allowed) or a list of strings, where the enum applies to each item.
func InputSchema[In any](enums map[string][]string) (*jsonschema.Schema, error) {
	s, err := jsonschema.For[In](schemaOptions)
	if err != nil {
		return nil, fmt.Errorf("infer schema: %w", err)
	}
	for prop, values := range enums {
		ps, ok := s.Properties[prop]
		if !ok {
			return nil, fmt.Errorf("enum for unknown property %q", prop)
		}
		if len(values) == 0 {
			return nil, fmt.Errorf("enum for %q is empty", prop)
		}
		if err := applyEnum(ps, values); err != nil {
			return nil, fmt.Errorf("enum for %q: %w", prop, err)
		}
	}
	return s, nil
}

func applyEnum(ps *jsonschema.Schema, values []string) error {
	enum := make([]any, len(values))
	for i, v := range values {
		enum[i] = v
	}
	// Pointers and slices infer as ["null", T].
	nullable := len(ps.Types) == 2 && slices.Contains(ps.Types, "null")
	is := func(typ string) bool { return ps.Type == typ || (nullable && slices.Contains(ps.Types, typ)) }

	switch {
	case is("string") && nullable:
		ps.Enum = append(enum, nil)
	case is("string"):
		ps.Enum = enum
	case is("array") && ps.Items != nil && ps.Items.Type == "string":
		ps.Items.Enum = enum
	default:
		return fmt.Errorf("property is %q%v, want string, *string or []string", ps.Type, ps.Types)
	}
	return nil
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
