return {
    LrSdkVersion = 14.0,
    LrSdkMinimumVersion = 6.0,

    LrToolkitIdentifier = "com.openai.file-queue-bridge",
    LrPluginName = "File Queue Bridge",

    VERSION = {
        major = 0,
        minor = 2,
        revision = 0,
        build = 1,
    },

    -- 桥由用户手动启停（Start/Stop 菜单），不在 LrInitPlugin 时自动启动，
    -- 避免插件加载路径与传输路径耦合。
    LrLibraryMenuItems = {
        {
            title = "Start File Queue Bridge",
            file = "Start.lua",
        },
        {
            title = "Stop File Queue Bridge",
            file = "Stop.lua",
        },
    },
}
