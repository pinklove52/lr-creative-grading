-- 阶段门控配置：能力按里程碑逐步开放，未验收的能力不提前暴露。
--
-- 实机验收推进时只改 stage 一个字段：
--   M1 = 队列传输自检（ping / capabilities / status）
--   M2 = 只读 SDK（get_target_photo / get_settings / get_proxy）
--   M3 = 写事务（apply_transaction / readback / rollback）
-- 切换后重启桥（Stop → Start），新门控随 session.json 发布。
local Config = {}

Config.stage = "M1"

Config.protocol_version = 2
Config.plugin_version = "0.2.0"
Config.queue_root_name = "LrCreativeGradingBridge-v2"

-- 请求/响应硬限制；两侧实现同一套规则，互不信任。
Config.max_request_bytes = 262144
Config.max_response_bytes = 262144
Config.max_json_depth = 32
Config.max_ttl_seconds = 300

Config.heartbeat_interval_seconds = 1
Config.poll_interval_seconds = 0.2
Config.keep_recent_request_ids = 128

-- 结构化日志轮转：超过上限后归档为 bridge.log.1，保留 2 份。
Config.log_max_bytes = 1048576
Config.log_keep_files = 1

Config.enabled_methods_by_stage = {
    M1 = { "ping", "capabilities", "status" },
    M2 = { "ping", "capabilities", "status", "get_target_photo", "get_settings", "get_proxy" },
    M3 = { "ping", "capabilities", "status", "get_target_photo", "get_settings", "get_proxy",
           "apply_transaction", "readback", "rollback" },
}

function Config.enabledMethods()
    return Config.enabled_methods_by_stage[Config.stage] or Config.enabled_methods_by_stage.M1
end

return Config
