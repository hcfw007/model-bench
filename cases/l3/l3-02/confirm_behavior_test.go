package bulk_send_v1_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	bo "mockrepo/go-projects/some-service/internal/biz/bulk_send_v1"
	"mockrepo/go-projects/some-service/internal/data"
)

func TestBenchCanceledConfirmDiffersFromOtherInvalidStates(t *testing.T) {
	ctx := context.Background()
	repo := data.NewMemoryJobRepo()
	useCase := bo.NewUseCase(bo.Deps{Repo: repo, CRM: data.NewMemoryCRMRepo(), Executor: data.NewMemoryExecutor()})
	for _, job := range []*bo.Job{
		{ID: "canceled", Status: bo.JobStatusCanceled},
		{ID: "finished", Status: bo.JobStatusFinished},
	} {
		if err := repo.Create(ctx, job); err != nil {
			t.Fatalf("create %s: %v", job.ID, err)
		}
	}
	canceled := useCase.Confirm(ctx, "canceled")
	finished := useCase.Confirm(ctx, "finished")
	if canceled == nil || !strings.Contains(canceled.Error(), "任务已取消，不能确认") {
		t.Fatalf("confirm canceled job: expected explicit message, got %v", canceled)
	}
	if !errors.Is(finished, bo.ErrInvalidStatus) || strings.Contains(finished.Error(), "任务已取消，不能确认") {
		t.Fatalf("confirm finished job: expected original invalid-status error, got %v", finished)
	}
	job, err := repo.Get(ctx, "canceled")
	if err != nil || job.Status != bo.JobStatusCanceled {
		t.Fatalf("canceled job state changed: %v, %v", job, err)
	}
}
