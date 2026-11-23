package service_test

import (
	"context"
	"sync"
	"testing"

	bo "mockrepo/go-projects/some-service/internal/biz/bulk_send_v1"
	"mockrepo/go-projects/some-service/internal/data"
	"mockrepo/go-projects/some-service/internal/service"
)

func TestBenchmarkCreateJobRequestID(t *testing.T) {
	ctx := context.Background()
	repo := data.NewMemoryJobRepo()
	create := service.NewBroadcastOfficialService(bo.NewUseCase(bo.Deps{Repo: repo})).CreateJob
	input := bo.CreateJobInput{
		OrgID: "org-1", BotID: "bot", Name: "test", NotifyMode: bo.NotifyModeManual,
		RequestID: "request-1", Targets: []bo.Target{{ExternalUserID: "target"}},
	}

	const attempts = 12
	var group sync.WaitGroup
	start := make(chan struct{})
	ids := make(chan string, attempts)
	for range attempts {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			job, err := create(ctx, input)
			if err != nil || job == nil || job.ID == "" {
				t.Errorf("retry failed: job=%+v err=%v", job, err)
				return
			}
			ids <- job.ID
		}()
	}
	close(start)
	group.Wait()
	close(ids)

	original := <-ids
	for id := range ids {
		if id != original {
			t.Errorf("concurrent retry created job %q; want %q", id, original)
		}
	}
	assertCount := func(status bo.JobStatus, want int) {
		t.Helper()
		jobs, err := repo.ListByStatus(ctx, status, attempts)
		if err != nil || len(jobs) != want {
			t.Fatalf("status %v: got %d jobs (err=%v), want %d", status, len(jobs), err, want)
		}
	}
	assertCount(bo.JobStatusCreated, 1)
	changed, err := repo.CompareAndSwapStatus(ctx, original, bo.JobStatusCreated, bo.JobStatusFinished)
	if err != nil || !changed {
		t.Fatalf("mark original finished: changed=%t err=%v", changed, err)
	}

	retry := input
	retry.Name = "changed retry body"
	result, err := create(ctx, retry)
	if err != nil || result == nil || result.ID != original || result.Name != input.Name ||
		result.Status != bo.JobStatusFinished {
		t.Fatalf("terminal retry did not return unchanged original: job=%+v err=%v", result, err)
	}
	assertCount(bo.JobStatusCreated, 0)
	assertCount(bo.JobStatusFinished, 1)

	anotherKey := input
	anotherKey.RequestID = "request-2"
	anotherOrg := input
	anotherOrg.OrgID = "org-2"
	unkeyed := input
	unkeyed.RequestID = ""
	seen := map[string]bool{original: true}
	for _, request := range []bo.CreateJobInput{anotherKey, anotherOrg, unkeyed, unkeyed} {
		job, err := create(ctx, request)
		if err != nil || job == nil || job.ID == "" || seen[job.ID] {
			t.Fatalf("independent submission did not create a distinct job: job=%+v err=%v", job, err)
		}
		seen[job.ID] = true
	}
	assertCount(bo.JobStatusCreated, 4)
}
