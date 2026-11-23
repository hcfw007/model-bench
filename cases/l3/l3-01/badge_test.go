package dependency

import (
	"testing"
	"time"
)

func TestBenchBulkSendBadgeRegistration(t *testing.T) {
	const feature = "BULK_SEND_V1"
	tests := []struct {
		region string
		day    int
	}{
		{region: "cn", day: 1},
		{region: "intl", day: 15},
	}
	for _, tt := range tests {
		t.Run(tt.region, func(t *testing.T) {
			want := time.Date(2026, time.July, tt.day, 0, 0, 0, 0, time.UTC)
			got, ok := NewBadgeRegionLaunchFeatures[tt.region][feature]
			if !ok || !got.Equal(want) || got.Location() != time.UTC {
				t.Fatalf("%s/%s launch = %v (registered=%t), want %v in UTC", tt.region, feature, got, ok, want)
			}
			if window := BadgeWindow(tt.region, feature); window != NewBadgeDefaultWindow {
				t.Fatalf("%s/%s window = %v, want %v", tt.region, feature, window, NewBadgeDefaultWindow)
			}
		})
	}
}
