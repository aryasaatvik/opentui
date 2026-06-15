// WASM build stub for audio.zig. Workers have no audio device, and miniaudio's
// C headers cannot be compiled for wasm32. lib.zig imports this instead of
// audio.zig on the wasm target; every export becomes a no-op / err_invalid.
const std = @import("std");

pub const Status = struct {
    pub const ok: i32 = 0;
    pub const err_invalid: i32 = -1;
    pub const err_no_space: i32 = -2;
    pub const err_decode: i32 = -3;
    pub const err_not_found: i32 = -4;
    pub const err_device: i32 = -5;
};

pub const max_voices: usize = 32;
pub const default_sample_rate: u32 = 48_000;
pub const default_playback_channels: u32 = 2;

pub const CreateOptions = extern struct {
    sample_rate: u32 = default_sample_rate,
    playback_channels: u32 = default_playback_channels,
};

pub const StartOptions = extern struct {
    period_size_in_frames: u32 = 0,
    period_size_in_milliseconds: u32 = 0,
    periods: u32 = 0,
    performance_profile: u8 = 0,
    share_mode: u8 = 0,
    no_pre_silenced_output_buffer: bool = false,
    no_clip: bool = false,
    no_disable_denormals: bool = false,
    no_fixed_sized_callback: bool = false,
    wasapi_no_auto_convert_src: bool = false,
    wasapi_no_default_quality_src: bool = false,
    alsa_no_mmap: bool = false,
    alsa_no_auto_format: bool = false,
    alsa_no_auto_channels: bool = false,
    alsa_no_auto_resample: bool = false,
};

pub const VoiceOptions = extern struct {
    volume: f32,
    pan: f32,
    loop: bool,
    group_id: u32,
};

pub const Stats = extern struct {
    sounds_loaded: u32,
    voices_active: u32,
    frames_mixed: u64,
    lock_misses: u32,
    last_peak: f32,
    last_rms: f32,
};

pub const Engine = struct {};

pub fn create(allocator: std.mem.Allocator, options_ptr: ?*const CreateOptions) ?*Engine {
    _ = allocator;
    _ = options_ptr;
    return null;
}
pub fn destroy(engine: *Engine) void {
    _ = engine;
}
pub fn refreshPlaybackDevices(engine: *Engine) i32 {
    _ = engine;
    return Status.err_invalid;
}
pub fn getPlaybackDeviceCount(engine: *Engine) u32 {
    _ = engine;
    return 0;
}
pub fn getPlaybackDeviceName(engine: *Engine, index: u32, out_ptr: ?[*]u8, max_len: usize) usize {
    _ = engine;
    _ = index;
    _ = out_ptr;
    _ = max_len;
    return 0;
}
pub fn isPlaybackDeviceDefault(engine: *Engine, index: u32) bool {
    _ = engine;
    _ = index;
    return false;
}
pub fn selectPlaybackDevice(engine: *Engine, index: u32) i32 {
    _ = engine;
    _ = index;
    return Status.err_invalid;
}
pub fn clearPlaybackDeviceSelection(engine: *Engine) void {
    _ = engine;
}
pub fn start(engine: *Engine, options_ptr: ?*const StartOptions) i32 {
    _ = engine;
    _ = options_ptr;
    return Status.err_invalid;
}
pub fn startMixer(engine: *Engine) i32 {
    _ = engine;
    return Status.err_invalid;
}
pub fn stop(engine: *Engine) i32 {
    _ = engine;
    return Status.err_invalid;
}
pub fn load(engine: *Engine, data_ptr: ?[*]const u8, data_len: usize, out_sound_id: ?*u32) i32 {
    _ = engine;
    _ = data_ptr;
    _ = data_len;
    _ = out_sound_id;
    return Status.err_invalid;
}
pub fn unload(engine: *Engine, sound_id: u32) i32 {
    _ = engine;
    _ = sound_id;
    return Status.err_invalid;
}
pub fn createGroup(engine: *Engine, name_ptr: ?[*]const u8, name_len: usize, out_group_id: ?*u32) i32 {
    _ = engine;
    _ = name_ptr;
    _ = name_len;
    _ = out_group_id;
    return Status.err_invalid;
}
pub fn play(engine: *Engine, sound_id: u32, options_ptr: ?*const VoiceOptions, out_voice_id: ?*u32) i32 {
    _ = engine;
    _ = sound_id;
    _ = options_ptr;
    _ = out_voice_id;
    return Status.err_invalid;
}
pub fn stopVoice(engine: *Engine, voice_id: u32) i32 {
    _ = engine;
    _ = voice_id;
    return Status.err_invalid;
}
pub fn setVoiceGroup(engine: *Engine, voice_id: u32, group_id: u32) i32 {
    _ = engine;
    _ = voice_id;
    _ = group_id;
    return Status.err_invalid;
}
pub fn setGroupVolume(engine: *Engine, group_id: u32, volume: f32) i32 {
    _ = engine;
    _ = group_id;
    _ = volume;
    return Status.err_invalid;
}
pub fn setMasterVolume(engine: *Engine, volume: f32) i32 {
    _ = engine;
    _ = volume;
    return Status.err_invalid;
}
pub fn enableTap(engine: *Engine, enabled: bool, capacity_frames: u32) i32 {
    _ = engine;
    _ = enabled;
    _ = capacity_frames;
    return Status.err_invalid;
}
pub fn readTap(engine: *Engine, out_ptr: ?[*]f32, frame_count: u32, channels: u8, out_frames_read: ?*u32) i32 {
    _ = engine;
    _ = out_ptr;
    _ = frame_count;
    _ = channels;
    _ = out_frames_read;
    return Status.err_invalid;
}
pub fn mixToBuffer(engine: *Engine, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    _ = engine;
    _ = out_ptr;
    _ = frame_count;
    _ = channels;
    return Status.err_invalid;
}
pub fn getStats(engine: *Engine, out_stats: ?*Stats) i32 {
    _ = engine;
    _ = out_stats;
    return Status.err_invalid;
}
