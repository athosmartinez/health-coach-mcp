BIN := bin/health-coach-mcp
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/athosmartinez/health-coach-mcp/internal/version.Version=$(VERSION)

.PHONY: build test lint run run-http tidy

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/health-coach-mcp

test:
	go test -race ./...

lint:
	@out=$$(gofmt -l .); if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	go vet ./...

run: build
	./$(BIN)

run-http: build
	./$(BIN) -transport=http

tidy:
	go mod tidy
