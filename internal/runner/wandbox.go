package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"
)

const (
	wandboxURL = "https://wandbox.org"

	// Без своего User-Agent Wandbox отвечает 403.
	userAgent = "OTORoom/1.0"

	// Wandbox сам молча обрывает огромный вывод, поэтому лимит держим ниже
	// их порога (~64 КиБ) — иначе обрезанное ими покажется полным.
	defaultMaxOutput = 32 << 10

	maxResponseBody = 2 << 20

	// Больше таймаута ручки (15 с), чтобы первым срабатывал контекст.
	httpTimeout = 20 * time.Second
)

type compilerSpec struct {
	name    string
	options string
}

// Конкретные версии, не *-head: head — ночные сборки.
var compilers = map[Language]compilerSpec{
	LangCPP:    {name: "gcc-13.2.0", options: "warning,gnu++2b"},
	LangPython: {name: "cpython-3.12.7"},
}

type WandboxRunner struct {
	baseURL   string // в тестах подменяется адресом httptest.Server
	http      *http.Client
	maxOutput int
}

// maxOutput — лимит на stdout и stderr по отдельности; 0 — по умолчанию.
func NewWandbox(maxOutput int) *WandboxRunner {
	if maxOutput <= 0 {
		maxOutput = defaultMaxOutput
	}
	return &WandboxRunner{
		baseURL:   wandboxURL,
		http:      &http.Client{Timeout: httpTimeout},
		maxOutput: maxOutput,
	}
}

type wandboxRequest struct {
	Compiler string `json:"compiler"`
	Code     string `json:"code"`
	Stdin    string `json:"stdin,omitempty"`
	Options  string `json:"options,omitempty"`
}

type wandboxResponse struct {
	Status        string `json:"status"` // строкой; "" — программу остановили они
	CompilerError string `json:"compiler_error"`
	ProgramOutput string `json:"program_output"`
	ProgramError  string `json:"program_error"`
}

func (w *WandboxRunner) Run(ctx context.Context, req Request) (Response, error) {
	spec, ok := compilers[req.Language]
	if !ok {
		return Response{}, fmt.Errorf("%w: %q", ErrUnsupportedLanguage, req.Language)
	}

	body, err := json.Marshal(wandboxRequest{
		Compiler: spec.name,
		Code:     req.Code,
		Stdin:    req.Stdin,
		Options:  spec.options,
	})
	if err != nil {
		return Response{}, fmt.Errorf("wandbox: собрать запрос: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		w.baseURL+"/api/compile.json", bytes.NewReader(body))
	if err != nil {
		return Response{}, fmt.Errorf("wandbox: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", userAgent)

	start := time.Now()
	resp, err := w.http.Do(httpReq)
	if err != nil {
		return Response{}, fmt.Errorf("wandbox: запрос: %w", err)
	}
	defer resp.Body.Close()

	// Ошибку компиляции Wandbox отдаёт с 200; не-200 — поломка самого сервиса.
	if resp.StatusCode != http.StatusOK {
		return Response{}, fmt.Errorf("wandbox: ответ %d", resp.StatusCode)
	}

	var wr wandboxResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBody)).Decode(&wr); err != nil {
		return Response{}, fmt.Errorf("wandbox: разобрать ответ: %w", err)
	}
	elapsed := time.Since(start)

	stopped := wr.Status == ""
	code := ExitStopped
	if !stopped {
		code, err = strconv.Atoi(wr.Status)
		if err != nil {
			return Response{}, fmt.Errorf("wandbox: непонятный status %q: %w", wr.Status, err)
		}
	}

	// У Python синтаксическая ошибка приходит в program_error, а не в
	// compiler_error, поэтому склеиваем оба.
	stdout, cutOut := truncate(wr.ProgramOutput, w.maxOutput)
	stderr, cutErr := truncate(wr.CompilerError+wr.ProgramError, w.maxOutput)

	return Response{
		Stdout:      stdout,
		Stderr:      stderr,
		ExitCode:    code,
		Duration:    elapsed,
		IsTruncated: cutOut || cutErr || stopped,
	}, nil
}

// truncate режет по границе символа, чтобы не разорвать кириллицу посередине.
func truncate(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}
