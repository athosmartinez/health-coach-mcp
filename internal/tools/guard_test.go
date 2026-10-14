package tools

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestToolsAreRegisteredThroughRegister enforces the error contract: a tool
// added with mcp.AddTool directly would send raw error text (which may carry
// health values) to the client.
func TestToolsAreRegisteredThroughRegister(t *testing.T) {
	root := filepath.Join("..", "..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "bin") {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if filepath.ToSlash(path) == "../../internal/tools/register.go" {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(src), ".AddTool(") {
			t.Errorf("%s registers a tool directly; use tools.Register", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
