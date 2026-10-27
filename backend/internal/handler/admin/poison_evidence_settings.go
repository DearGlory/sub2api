package admin

import (
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func (h *SettingHandler) GetPoisonEvidenceSettings(c *gin.Context) {
	settings, err := h.settingService.GetPoisonEvidenceSettings(c.Request.Context())
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, settings)
}

func (h *SettingHandler) UpdatePoisonEvidenceSettings(c *gin.Context) {
	var request service.PoisonEvidenceSettingsUpdate
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, "Invalid settings body")
		return
	}
	if err := h.settingService.UpdatePoisonEvidenceSettings(c.Request.Context(), request); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	h.GetPoisonEvidenceSettings(c)
}
