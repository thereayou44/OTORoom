package runner

import (
	"context"
	"errors"
	"time"
)

type Runner interface {
	// Ошибка компиляции или упавшая программа — валидный Response с ненулевым
	// ExitCode. error — только если сам запуск не состоялся.
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

// ExitStopped — программу остановил сервис до завершения (например, за
// слишком большой вывод).
const ExitStopped = -1

type Language string

const (
	LangCPP    Language = "cpp"
	LangPython Language = "python"
)

var ErrUnsupportedLanguage = errors.New("язык не поддерживается")
