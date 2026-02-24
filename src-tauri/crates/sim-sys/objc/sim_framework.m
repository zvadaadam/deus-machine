#import "sim_bridge_internal.h"

// ============================================================================
// MARK: - Framework loading
// ============================================================================

static void* g_coreSimHandle = NULL;
static void* g_simKitHandle = NULL;
static bool g_frameworksLoaded = false;

NSString* get_xcode_developer_path(void) {
    NSPipe *pipe = [NSPipe pipe];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
    task.arguments = @[@"-p"];
    task.standardOutput = pipe;
    task.standardError = [NSPipe pipe];

    NSError *error = nil;
    [task launchAndReturnError:&error];
    if (error) return @"/Applications/Xcode.app/Contents/Developer";

    [task waitUntilExit];
    NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
    NSString *path = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return [path stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

bool load_frameworks(char* error_buf, int error_buf_len) {
    if (g_frameworksLoaded) return true;

    // Load CoreSimulator from system PrivateFrameworks
    g_coreSimHandle = dlopen(
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        RTLD_LAZY
    );
    if (!g_coreSimHandle) {
        snprintf(error_buf, error_buf_len,
                 "Failed to load CoreSimulator.framework: %s", dlerror());
        return false;
    }

    // Load SimulatorKit from Xcode PrivateFrameworks
    NSString *devPath = get_xcode_developer_path();
    NSString *simKitPath = [devPath stringByAppendingPathComponent:
        @"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
    g_simKitHandle = dlopen([simKitPath UTF8String], RTLD_LAZY);
    if (!g_simKitHandle) {
        snprintf(error_buf, error_buf_len,
                 "Failed to load SimulatorKit.framework: %s", dlerror());
        return false;
    }

    g_frameworksLoaded = true;
    return true;
}
