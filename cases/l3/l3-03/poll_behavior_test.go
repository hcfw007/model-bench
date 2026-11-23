package bulk_send_v1_test

import (
	"context"
	"testing"

	bo "mockrepo/go-projects/some-service/internal/biz/bulk_send_v1"
	"mockrepo/go-projects/some-service/internal/data"
)

func TestBenchSyncSettlesFailedTargetsButNotPendingTargets(t *testing.T) {
	for _, tt := range []struct {
		name       string
		lastStatus int32
		want       bo.JobStatus
	}{
		{"failed", 2, bo.JobStatusFinished},
		{"pending", 0, bo.JobStatusSending},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			repo := data.NewMemoryJobRepo()
			useCase := bo.NewUseCase(bo.Deps{Repo: repo, CRM: data.NewMemoryCRMRepo(), Executor: data.NewMemoryExecutor()})
			job := &bo.Job{ID: tt.name, Status: bo.JobStatusSending, Targets: []bo.Target{
				{ExternalUserID: "sent", Status: 1},
				{ExternalUserID: "last", Status: tt.lastStatus},
			}}
			if err := repo.Create(ctx, job); err != nil {
				t.Fatalf("create: %v", err)
			}
			if err := useCase.SyncJob(ctx, job.ID); err != nil {
				t.Fatalf("sync: %v", err)
			}
			actual, err := repo.Get(ctx, job.ID)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if actual.Status != tt.want || actual.SentCount != 1 {
				t.Fatalf("status=%v sent=%d; want status=%v sent=1", actual.Status, actual.SentCount, tt.want)
			}
		})
	}
}
