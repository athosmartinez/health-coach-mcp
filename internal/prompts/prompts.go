// Package prompts registers the coach's MCP prompts, one per coaching moment,
// and the coach://guardrails resource with the rules every moment follows.
package prompts

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// GuardrailsURI names the guardrails resource.
const GuardrailsURI = "coach://guardrails"

//go:embed guardrails.md
var guardrails string

// RegisterGuardrails adds the coach://guardrails resource.
func RegisterGuardrails(s *mcp.Server) {
	s.AddResource(&mcp.Resource{
		URI: GuardrailsURI, Name: "guardrails", Title: "Coach guardrails", MIMEType: "text/markdown",
		Description: "The coach's medical limits, data rules and tone. Every coaching answer follows them.",
	}, func(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{
			{URI: GuardrailsURI, MIMEType: "text/markdown", Text: guardrails},
		}}, nil
	})
}

// moment is one coaching prompt: the tool it runs, the tool's day argument
// and what the coach does with the result.
type moment struct {
	name, title, description string
	tool, arg, argHelp       string
	task                     string
}

var moments = []moment{
	{
		name: "morning_briefing", title: "Morning briefing",
		description: "Last night's sleep and recovery against the user's baseline, and today's training call.",
		tool:        "morning_briefing", arg: "date", argHelp: "local day the night ended (YYYY-MM-DD); omit for today",
		task: "Tell the user how they slept and recovered against their own baseline, then give today's " +
			"training call (train as planned, go lighter or rest) with one reason. If readiness is red, the call is " +
			"go lighter or rest. If the user reports symptoms or pain, the call is rest and the guardrails decide " +
			"what else to say. Keep it short.",
	},
	{
		name: "nutrition_review", title: "Nutrition review",
		description: "One day's food log against the targets in force.",
		tool:        "nutrition_day", arg: "date", argHelp: "local day of the log (YYYY-MM-DD); omit for today",
		task: "Review the day's intake against the targets in force: calories, protein (also per kg of body " +
			"weight) and the energy balance when the tool gives one. Say what to adjust in the next meal or day, " +
			"in foods, not only numbers. Over a target, say so plainly; never suggest skipping or shrinking a meal " +
			"to make up for it.",
	},
	{
		name: "workout_review", title: "Workout review",
		description: "One day's training sessions and the week's training load against the plan.",
		tool:        "workout_review", arg: "date", argHelp: "local day to review (YYYY-MM-DD); omit for today",
		task: "Review the sessions: duration, heart-rate zones, Active Zone Minutes and the week's sessions " +
			"against the plan. Say what went well and how to adjust the next session, within the user's health " +
			"items and recovery.",
	},
	{
		name: "weekly_report", title: "Weekly report",
		description: "The week against the previous week and the 28-day average, with next week's priorities.",
		tool:        "weekly_report", arg: "week_end", argHelp: "any local day of the week (YYYY-MM-DD); omit for this week",
		task: "Summarize the week against the previous week and the 28-day average: weight, body fat, resting " +
			"heart rate, HRV, sleep, steps and adherence, and the decisions recorded this week. Pick at most " +
			"three priorities for next week.",
	},
}

// Register adds one prompt per coaching moment. Each prompt names tools the
// server must also register: profile_get and the moment's own tool.
func Register(s *mcp.Server) {
	for _, m := range moments {
		s.AddPrompt(&mcp.Prompt{
			Name: m.name, Title: m.title, Description: m.description,
			Arguments: []*mcp.PromptArgument{{Name: m.arg, Description: m.argHelp}},
		}, m.handle)
	}
}

func (m moment) handle(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	call := "Call " + m.tool + " with no arguments (it picks the default day)."
	if v := req.Params.Arguments[m.arg]; v != "" {
		// Only a parsed date reaches the text, so an argument cannot carry
		// instructions; the error does not repeat the input either.
		d, err := coach.ParseDate(v)
		if err != nil {
			return nil, fmt.Errorf("%s must be a calendar date (YYYY-MM-DD)", m.arg)
		}
		call = fmt.Sprintf("Call %s with {%q: %q}.", m.tool, m.arg, string(d))
	}
	text := "You are the user's health and fitness coach.\n\n" +
		"1. Call profile_get for the user's goals, targets, health history and preferences.\n" +
		"2. " + call + "\n" +
		"3. " + m.task + "\n\n" +
		"Follow the coach guardrails below (also the " + GuardrailsURI + " resource) in everything you say.\n\n" +
		guardrails
	return &mcp.GetPromptResult{
		Description: m.description,
		Messages:    []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: text}}},
	}, nil
}
