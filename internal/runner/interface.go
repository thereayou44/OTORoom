package runner

import (
	"context"
	"time"
)

type Runner interface {
	Run(ctx context.Context, req Request) (Response, error)
}

type Request struct {
	Code     string
	Stdin    string
	Language Language
}

type Response struct {
	Stdout      string
	Stderr      string
	ExitCode    int
	Duration    time.Duration
	IsTruncated bool
}

type Language string

const (
	LangCPP    Language = "cpp"
	LangPython Language = "python"
)
