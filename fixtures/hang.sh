#!/usr/bin/env bash
# 模拟一个永不返回的外部调用，用于测试 subagent 卡死时主会话是否会主动介入。
# 最多跑 300 秒；runner 会在 case 超时后清理。
echo "started at $(date +%s)"
sleep 300
echo "this should never be printed within a normal case timeout"
