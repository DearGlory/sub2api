package admin

import (
	"context"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// PoisonSharedAdmin provides non-secret state and asynchronous task submission.
// It is installed during router construction, before requests can be served.
type PoisonSharedAdmin struct {
	State     func(context.Context) (any, error)
	Reconcile func(context.Context) error
	Backfill  func(context.Context) (string, error)
}

func (h *SettingHandler) SetPoisonSharedAdmin(actions *PoisonSharedAdmin) { h.poisonShared = actions }
func (h *SettingHandler) GetPoisonShared(c *gin.Context) {
	enabled, err := h.settingService.GetPoisonSharedEnabled(c.Request.Context())
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	var state any
	if h.poisonShared != nil && h.poisonShared.State != nil {
		state, err = h.poisonShared.State(c.Request.Context())
		if err != nil {
			response.Error(c, http.StatusServiceUnavailable, "Shared proxy state unavailable")
			return
		}
	}
	response.Success(c, gin.H{"enabled": enabled, "state": state})
}
func (h *SettingHandler) UpdatePoisonShared(c *gin.Context) {
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		response.BadRequest(c, "Invalid shared proxy settings body")
		return
	}
	if err := h.settingService.UpdatePoisonSharedEnabled(c.Request.Context(), in.Enabled); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	h.GetPoisonShared(c)
}
func (h *SettingHandler) ReconcilePoisonShared(c *gin.Context) {
	if h.poisonShared == nil || h.poisonShared.Reconcile == nil {
		response.Error(c, 503, "Shared proxy coordinator unavailable")
		return
	}
	if err := h.poisonShared.Reconcile(c.Request.Context()); err != nil {
		response.Error(c, 503, "Shared proxy reconciliation incomplete")
		return
	}
	h.GetPoisonShared(c)
}
func (h *SettingHandler) BackfillPoisonShared(c *gin.Context) {
	if h.poisonShared == nil || h.poisonShared.Backfill == nil {
		response.Error(c, 503, "Shared proxy coordinator unavailable")
		return
	}
	id, err := h.poisonShared.Backfill(c.Request.Context())
	if err != nil {
		response.Error(c, 503, "Shared proxy retest was not submitted")
		return
	}
	response.Success(c, gin.H{"run_id": id})
}
