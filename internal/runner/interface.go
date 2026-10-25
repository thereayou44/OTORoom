// Package runner запускает код ученика и возвращает его вывод.
//
// Контракт здесь общий для всех реализаций: сейчас код исполняет Wandbox
// (wandbox.go), позже — свой Docker. Замена реализации не должна требовать
// правок у вызывающего кода, поэтому ничего специфичного для Wandbox —
// имён компиляторов, URL — в этом файле быть не должно.
package runner

import (
	"context"
	"errors"
	"time"
)

type Runner interface {
	// Run исполняет код. Ошибка компиляции или упавшая программа — это
	// валидный Response с ненулевым ExitCode, а не error. error означает,
	// что сам запуск не состоялся: сервис недоступен, истёк таймаут ctx.
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
	ExitCode    int // ExitStopped, если программа не завершилась сама
	Duration    time.Duration
	IsTruncated bool // вывод не влез в лимит и обрезан
}

// ExitStopped — код возврата программы, которую остановил сервис запуска
// до того, как она завершилась сама (например, за слишком большой вывод).
// Запуск при этом состоялся и вывод есть, поэтому это результат, а не error.
// Настоящих кодов возврата меньше нуля не бывает, так что путаницы нет.
const ExitStopped = -1

type Language string

const (
	LangCPP    Language = "cpp"
	LangPython Language = "python"
)

// ErrUnsupportedLanguage возвращает любая реализация, которая не умеет
// запускать запрошенный язык. Вызывающий проверяет её через errors.Is.
var ErrUnsupportedLanguage = errors.New("язык не поддерживается")
