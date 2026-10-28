package handler

import (
	"database/sql"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"log"
)

// SetupPoisonGuard installs evidence reporting; the shared runtime supplies the sole disposition handler.
func SetupPoisonGuard(db *sql.DB, proxyService *service.ProxyService, accountService *service.AccountService) {
	if db == nil {
		return
	}
	poison.AttachHandler(&poison.Handler{ReportDisposition: func(inc poison.Incident, d poison.Disposition) {
		if err := poison.WriteEvidenceDisposition(inc.EvidencePath, d); err != nil {
			log.Printf("[poison-evidence] id=%s error=disposition_write", inc.EvidenceID)
		}
	}})
}
