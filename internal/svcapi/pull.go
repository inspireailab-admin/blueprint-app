// Pull-to-remote endpoint. Lets the desktop GUI ask a remote svc to
// download a catalog model directly onto the remote host instead of
// requiring an SSH-and-CLI dance.
//
// API shape:
//
//   POST /v1/pull         body: {modelId, quant}
//                         → kicks off (or attaches to an existing)
//                           background download. Idempotent. Returns
//                           the current PullState immediately.
//
//   GET  /v1/pull?modelId=...&quant=...
//                         → returns the current PullState for
//                           (modelId, quant). 404 when no pull has
//                           ever been requested for that pair.
//
// State machine:  pulling → done | error
//
// State lives in an in-memory map keyed by "modelId/quant". On svc
// restart the map is empty; partial downloads survive on disk as
// .part files (download.FileWithOptions resumes from them on the
// next pull).
//
// Author: Amar Mond.
package svcapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-cli/pkg/catalog"
	"github.com/inspireailab-admin/blueprint-cli/pkg/download"
	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// PullState is what /v1/pull and /v1/pull?... return. Mirrors the
// shape the desktop GUI consumes for local pulls so the React layer
// can render either uniformly.
type PullState struct {
	ModelID         string `json:"modelId"`
	Quant           string `json:"quant"`
	Stage           string `json:"stage"` // "pulling" | "done" | "error"
	BytesDownloaded int64  `json:"bytesDownloaded"`
	BytesTotal      int64  `json:"bytesTotal"`
	BytesPerSecond  int64  `json:"bytesPerSecond"`
	Error           string `json:"error,omitempty"`
	Path            string `json:"path,omitempty"`
	StartedAtMs     int64  `json:"startedAtMs"`
	UpdatedAtMs     int64  `json:"updatedAtMs"`
}

var (
	pullMu    sync.Mutex
	pullState = map[string]*PullState{}
)

func pullKey(modelID, quant string) string {
	return modelID + "/" + quant
}

func getPull(modelID, quant string) (PullState, bool) {
	pullMu.Lock()
	defer pullMu.Unlock()
	s, ok := pullState[pullKey(modelID, quant)]
	if !ok {
		return PullState{}, false
	}
	return *s, true
}

func setPull(s *PullState) {
	pullMu.Lock()
	defer pullMu.Unlock()
	s.UpdatedAtMs = time.Now().UnixMilli()
	pullState[pullKey(s.ModelID, s.Quant)] = s
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.handlePullStart(w, r)
	case http.MethodGet:
		s.handlePullStatus(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]string{"error": "POST to kick off, GET ?modelId=&quant= for status"})
	}
}

type pullRequest struct {
	ModelID string `json:"modelId"`
	Quant   string `json:"quant"`
}

func (s *Server) handlePullStart(w http.ResponseWriter, r *http.Request) {
	var in pullRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if in.ModelID == "" || in.Quant == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "modelId and quant are required"})
		return
	}

	model, err := catalog.Get(in.ModelID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	url, fileName, err := model.DownloadURL(in.Quant)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	dst, err := paths.ModelFile(in.ModelID, fileName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Idempotent: if an active pull for this pair is already in
	// flight, return its current state instead of spawning a second
	// downloader (which would race over the .part file).
	if cur, ok := getPull(in.ModelID, in.Quant); ok && cur.Stage == "pulling" {
		writeJSON(w, http.StatusOK, cur)
		return
	}

	now := time.Now().UnixMilli()
	st := &PullState{
		ModelID:     in.ModelID,
		Quant:       in.Quant,
		Stage:       "pulling",
		Path:        dst,
		StartedAtMs: now,
		UpdatedAtMs: now,
	}
	setPull(st)

	go runPull(url, dst, in.ModelID, in.Quant)

	writeJSON(w, http.StatusAccepted, *st)
}

func runPull(url, dst, modelID, quant string) {
	err := download.FileWithOptions(context.Background(), url, dst, download.Options{
		OnProgress: func(p download.Progress) {
			setPull(&PullState{
				ModelID:         modelID,
				Quant:           quant,
				Stage:           "pulling",
				BytesDownloaded: p.BytesDownloaded,
				BytesTotal:      p.BytesTotal,
				BytesPerSecond:  p.BytesPerSecond,
				Path:            dst,
				StartedAtMs:     pullStartedAt(modelID, quant),
			})
		},
	})
	final := &PullState{
		ModelID:     modelID,
		Quant:       quant,
		Path:        dst,
		StartedAtMs: pullStartedAt(modelID, quant),
	}
	if err != nil {
		final.Stage = "error"
		final.Error = err.Error()
	} else {
		final.Stage = "done"
	}
	setPull(final)
}

func pullStartedAt(modelID, quant string) int64 {
	if cur, ok := getPull(modelID, quant); ok && cur.StartedAtMs > 0 {
		return cur.StartedAtMs
	}
	return time.Now().UnixMilli()
}

func (s *Server) handlePullStatus(w http.ResponseWriter, r *http.Request) {
	modelID := r.URL.Query().Get("modelId")
	quant := r.URL.Query().Get("quant")
	if modelID == "" || quant == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "modelId and quant query params are required"})
		return
	}
	cur, ok := getPull(modelID, quant)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("no pull recorded for %s/%s", modelID, quant),
		})
		return
	}
	writeJSON(w, http.StatusOK, cur)
}
