package bulk_send_v1_test

import (
	"context"
	"testing"

	bo "mockrepo/go-projects/some-service/internal/biz/bulk_send_v1"
	"mockrepo/go-projects/some-service/internal/data"
)

// 场景：3 个对象，2 成功 1 失败 → 任务必须收敛为 FINISHED。
func TestConvergesWhenSomeTargetsFailed(t *testing.T) {
	repo := data.NewMemoryJobRepo()
	uc := bo.NewUseCase(bo.Deps{Repo: repo, CRM: data.NewMemoryCRMRepo(), Executor: data.NewMemoryExecutor()})
	ctx := context.Background()

	job, err := uc.CreateJob(ctx, bo.CreateJobInput{
		OrgID: "org1", BotID: "bot1", Name: "partial-fail",
		NotifyMode: bo.NotifyModeManual,
		Targets: []bo.Target{
			{ExternalUserID: "a", Status: 1},
			{ExternalUserID: "b", Status: 1},
			{ExternalUserID: "c", Status: 2},
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ok, err := repo.CompareAndSwapStatus(ctx, job.ID, bo.JobStatusCreated, bo.JobStatusSending); err != nil || !ok {
		t.Fatalf("cas to sending: ok=%v err=%v", ok, err)
	}
	if err := uc.SyncJob(ctx, job.ID); err != nil {
		t.Fatalf("sync: %v", err)
	}
	got, err := repo.Get(ctx, job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Status != bo.JobStatusFinished {
		t.Fatalf("有失败对象时任务仍不收敛: want FINISHED(4), got %d", got.Status)
	}
}

// 场景：绑定了自动标签，2 成功 1 失败 → 只对成功的 2 个打标，且重复收尾不重复打。
func TestMarkTagOnlyForSentTargetsAndIdempotent(t *testing.T) {
	repo := data.NewMemoryJobRepo()
	crm := data.NewMemoryCRMRepo()
	uc := bo.NewUseCase(bo.Deps{Repo: repo, CRM: crm, Executor: data.NewMemoryExecutor()})
	ctx := context.Background()

	job, err := uc.CreateJob(ctx, bo.CreateJobInput{
		OrgID: "org1", BotID: "bot1", Name: "auto-tag",
		NotifyMode: bo.NotifyModeManual,
		MarkTag:   &bo.BindingMarkTagInfo{TagType: bo.MarkTagTypeWecom, TagIDs: []string{"tag-1"}},
		Targets: []bo.Target{
			{ExternalUserID: "a", Status: 1},
			{ExternalUserID: "b", Status: 1},
			{ExternalUserID: "c", Status: 2},
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ok, _ := repo.CompareAndSwapStatus(ctx, job.ID, bo.JobStatusCreated, bo.JobStatusSending); !ok {
		t.Fatal("cas failed")
	}
	for i := 0; i < 2; i++ {
		if err := uc.SyncJob(ctx, job.ID); err != nil {
			t.Fatalf("sync %d: %v", i, err)
		}
	}

	calls := crm.Calls()
	if len(calls) != 2 {
		t.Fatalf("打标次数应为 2（仅成功对象且幂等），got %d", len(calls))
	}
	for _, c := range calls {
		if c.ExternalUserID == "c" {
			t.Fatalf("失败对象 c 不应被打标")
		}
		if c.TagID != "tag-1" {
			t.Fatalf("tagId 错误: %s", c.TagID)
		}
	}
}
