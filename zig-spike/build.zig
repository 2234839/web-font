const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseFast });
    const exe = b.addExecutable(.{
        .name = "webfont-zig",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = b.standardTargetOptions(.{}),
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);
    const run_cmd = b.addRunArtifact(exe);
    const run_step = b.step("run", "Run server");
    run_step.dependOn(&run_cmd.step);
}
