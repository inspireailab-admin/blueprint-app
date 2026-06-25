// LoRA training IPC — drives the train.py sidecar from the Dashboard.
//
// Lifecycle: lazy. First StartLoraTraining call spawns the sidecar,
// waits for /health. Sidecar stays up for the app's lifetime; jobs
// run as background threads inside it. State is persisted to
// ~/.blueprint/lora/jobs/<job_id>/meta.json so the Go side can poll
// without keeping anything in memory.

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/pyruntime"
	"github.com/inspireailab-admin/blueprint-app/internal/sidecar"
)

// ─── Lifecycle ────────────────────────────────────────────────────────────

var (
	trainMu      sync.Mutex
	trainSidecar *sidecar.Sidecar
)

func ensureTrainSidecar() (*sidecar.Sidecar, error) {
	trainMu.Lock()
	defer trainMu.Unlock()

	if trainSidecar != nil {
		if err := trainSidecar.WaitHealthy(1 * time.Second); err == nil {
			return trainSidecar, nil
		}
		trainSidecar.Stop()
		trainSidecar = nil
	}

	if !pyruntime.IsInstalled(pyruntime.FeatureLoRATraining) {
		return nil, fmt.Errorf("LoRA training feature is not installed — install it via the Dashboard's Python runtime card")
	}

	s, err := sidecar.Spawn("train.py", nil)
	if err != nil {
		return nil, err
	}
	if err := s.WaitHealthy(30 * time.Second); err != nil {
		s.Stop()
		return nil, err
	}
	trainSidecar = s
	return s, nil
}

// LoraTrainingStatus reports whether the sidecar is reachable + how
// many jobs are active. UI gates training-related controls on this.
type LoraTrainingStatus struct {
	FeatureInstalled bool `json:"featureInstalled"`
	SidecarRunning   bool `json:"sidecarRunning"`
	SidecarPort      int  `json:"sidecarPort,omitempty"`
	ActiveJobs       int  `json:"activeJobs"`
}

// LoraTrainingStatus is a cheap probe the UI polls.
func (a *App) LoraTrainingStatus() LoraTrainingStatus {
	out := LoraTrainingStatus{
		FeatureInstalled: pyruntime.IsInstalled(pyruntime.FeatureLoRATraining),
	}
	trainMu.Lock()
	s := trainSidecar
	trainMu.Unlock()
	if s == nil {
		return out
	}
	out.SidecarRunning = true
	out.SidecarPort = s.Port
	resp, err := http.Get(fmt.Sprintf("%s/health", s.BaseURL()))
	if err == nil {
		defer resp.Body.Close()
		var probe struct {
			Active int `json:"jobs_active"`
		}
		if json.NewDecoder(resp.Body).Decode(&probe) == nil {
			out.ActiveJobs = probe.Active
		}
	}
	return out
}

// ─── Job APIs ─────────────────────────────────────────────────────────────

// LoraTrainStartInput mirrors train.py's TrainStartRequest.
type LoraTrainStartInput struct {
	BaseModel       string   `json:"baseModel"`
	DatasetPath     string   `json:"datasetPath"`
	OutputLabel     string   `json:"outputLabel"`
	Epochs          float64  `json:"epochs"`
	LearningRate    float64  `json:"learningRate"`
	LoraRank        int      `json:"loraRank"`
	LoraAlpha       int      `json:"loraAlpha"`
	LoraDropout     float64  `json:"loraDropout"`
	TargetModules   []string `json:"targetModules"`
	BatchSize       int      `json:"batchSize"`
	GradAccumSteps  int      `json:"gradAccumSteps"`
	MaxSeqLength    int      `json:"maxSeqLength"`
	Use4bit         bool     `json:"use4bit"`
	UseFp16         bool     `json:"useFp16"`
}

// StartLoraTraining posts a fresh job to the sidecar. Returns the
// assigned job_id; UI polls LoraTrainingJob(jobId) for progress.
func (a *App) StartLoraTraining(in LoraTrainStartInput) (string, error) {
	s, err := ensureTrainSidecar()
	if err != nil {
		return "", err
	}
	// Defaults that mirror train.py's pydantic model.
	if in.Epochs == 0 {
		in.Epochs = 3
	}
	if in.LearningRate == 0 {
		in.LearningRate = 2e-4
	}
	if in.LoraRank == 0 {
		in.LoraRank = 16
	}
	if in.LoraAlpha == 0 {
		in.LoraAlpha = 32
	}
	if in.LoraDropout == 0 {
		in.LoraDropout = 0.05
	}
	if len(in.TargetModules) == 0 {
		in.TargetModules = []string{"q_proj", "k_proj", "v_proj", "o_proj"}
	}
	if in.BatchSize == 0 {
		in.BatchSize = 2
	}
	if in.GradAccumSteps == 0 {
		in.GradAccumSteps = 4
	}
	if in.MaxSeqLength == 0 {
		in.MaxSeqLength = 2048
	}

	body, err := json.Marshal(map[string]any{
		"base_model":         in.BaseModel,
		"dataset_path":       in.DatasetPath,
		"output_label":       in.OutputLabel,
		"epochs":             in.Epochs,
		"learning_rate":      in.LearningRate,
		"lora_rank":          in.LoraRank,
		"lora_alpha":         in.LoraAlpha,
		"lora_dropout":       in.LoraDropout,
		"target_modules":     in.TargetModules,
		"batch_size":         in.BatchSize,
		"grad_accum_steps":   in.GradAccumSteps,
		"max_seq_length":     in.MaxSeqLength,
		"use_4bit":           in.Use4bit,
		"use_fp16":           in.UseFp16,
	})
	if err != nil {
		return "", err
	}
	resp, err := postJSON(fmt.Sprintf("%s/train/start", s.BaseURL()), body)
	if err != nil {
		return "", err
	}
	var out struct {
		JobID string `json:"job_id"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		return "", fmt.Errorf("decode train_start: %w", err)
	}
	return out.JobID, nil
}

// LoraTrainingJob reports one job's state.
type LoraTrainingJob struct {
	JobID         string  `json:"jobId"`
	Label         string  `json:"label"`
	BaseModel     string  `json:"baseModel"`
	DatasetPath   string  `json:"datasetPath"`
	OutputDir     string  `json:"outputDir"`
	Status        string  `json:"status"`
	StartedAtMs   int64   `json:"startedAtMs"`
	FinishedAtMs  int64   `json:"finishedAtMs"`
	CurrentStep   int     `json:"currentStep"`
	TotalSteps    int     `json:"totalSteps"`
	LastLoss      float64 `json:"lastLoss"`
	LastError     string  `json:"lastError"`
}

// ListLoraTrainingJobs returns every job the sidecar knows about,
// including finished ones from disk.
func (a *App) ListLoraTrainingJobs() ([]LoraTrainingJob, error) {
	s, err := ensureTrainSidecar()
	if err != nil {
		return nil, err
	}
	resp, err := getJSON(fmt.Sprintf("%s/train/jobs", s.BaseURL()))
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		Jobs []rawJob `json:"jobs"`
	}
	if err := json.Unmarshal(resp, &wrapper); err != nil {
		return nil, err
	}
	out := make([]LoraTrainingJob, len(wrapper.Jobs))
	for i, j := range wrapper.Jobs {
		out[i] = j.toGo()
	}
	return out, nil
}

// LoraTrainingJobLog returns the last N log lines of a job for the UI's
// log tail.
func (a *App) LoraTrainingJobLog(jobID string, lines int) ([]string, error) {
	s, err := ensureTrainSidecar()
	if err != nil {
		return nil, err
	}
	if lines <= 0 {
		lines = 200
	}
	resp, err := getJSON(fmt.Sprintf("%s/train/jobs/%s/log?lines=%d", s.BaseURL(), jobID, lines))
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(resp, &wrapper); err != nil {
		return nil, err
	}
	return wrapper.Lines, nil
}

// CancelLoraTrainingJob signals the running job to stop. The trainer
// honors the cancel flag at the next on_log/on_step_end callback.
func (a *App) CancelLoraTrainingJob(jobID string) error {
	s, err := ensureTrainSidecar()
	if err != nil {
		return err
	}
	_, err = postJSON(fmt.Sprintf("%s/train/jobs/%s/cancel", s.BaseURL(), jobID), nil)
	return err
}

// StopTrainSidecar kills the sidecar (frees ~8 GB of memory once a
// model is loaded).
func (a *App) StopTrainSidecar() {
	trainMu.Lock()
	defer trainMu.Unlock()
	if trainSidecar != nil {
		trainSidecar.Stop()
		trainSidecar = nil
	}
}

// ─── HTTP helpers + raw types ─────────────────────────────────────────────

// rawJob mirrors the snake_case JSON shape the Python sidecar uses.
type rawJob struct {
	JobID        string  `json:"job_id"`
	Label        string  `json:"label"`
	BaseModel    string  `json:"base_model"`
	DatasetPath  string  `json:"dataset_path"`
	OutputDir    string  `json:"output_dir"`
	Status       string  `json:"status"`
	StartedAtMs  int64   `json:"started_at_ms"`
	FinishedAtMs int64   `json:"finished_at_ms"`
	CurrentStep  int     `json:"current_step"`
	TotalSteps   int     `json:"total_steps"`
	LastLoss     float64 `json:"last_loss"`
	LastError    string  `json:"last_error"`
}

func (r rawJob) toGo() LoraTrainingJob {
	return LoraTrainingJob{
		JobID:        r.JobID,
		Label:        r.Label,
		BaseModel:    r.BaseModel,
		DatasetPath:  r.DatasetPath,
		OutputDir:    r.OutputDir,
		Status:       r.Status,
		StartedAtMs:  r.StartedAtMs,
		FinishedAtMs: r.FinishedAtMs,
		CurrentStep:  r.CurrentStep,
		TotalSteps:   r.TotalSteps,
		LastLoss:     r.LastLoss,
		LastError:    r.LastError,
	}
}

func postJSON(url string, body []byte) ([]byte, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
	}
	return b, nil
}

func getJSON(url string) ([]byte, error) {
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
	}
	return b, nil
}
