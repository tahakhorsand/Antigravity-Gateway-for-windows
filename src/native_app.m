#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
    // 1. Ensure server is running
    [self ensureServerRunning];

    // 2. Setup Native Window
    NSRect frame = NSMakeRect(0, 0, 1040, 740);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | 
                              NSWindowStyleMaskClosable | 
                              NSWindowStyleMaskMiniaturizable | 
                              NSWindowStyleMaskResizable |
                              NSWindowStyleMaskFullSizeContentView;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];

    [self.window setTitle:@"Antigravity Harness"];
    [self.window setTitleVisibility:NSWindowTitleHidden];
    [self.window setTitlebarAppearsTransparent:YES];
    self.window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
    [self.window setBackgroundColor:[NSColor colorWithCalibratedRed:11.0/255.0 green:15.0/255.0 blue:23.0/255.0 alpha:1.0]];
    [self.window center];
    self.window.delegate = self;

    // 3. Setup WKWebView
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self.webView setValue:@NO forKey:@"drawsBackground"];

    [self.window.contentView addSubview:self.webView];

    // Load Dashboard
    NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:8045/dashboard"];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];

    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!flag) {
        [self.window makeKeyAndOrderFront:nil];
    }
    return YES;
}

- (void)ensureServerRunning {
    NSTask *checkTask = [[NSTask alloc] init];
    checkTask.launchPath = @"/usr/bin/curl";
    checkTask.arguments = @[@"-s", @"--connect-timeout", @"1", @"http://127.0.0.1:8045/health"];
    NSPipe *pipe = [NSPipe pipe];
    checkTask.standardOutput = pipe;
    [checkTask launch];
    [checkTask waitUntilExit];

    NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
    NSString *output = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];

    if (![output containsString:@"status"]) {
        // Start server in background
        NSTask *nodeTask = [[NSTask alloc] init];
        nodeTask.launchPath = @"/opt/homebrew/bin/node";
        NSString *serverPath = [NSString stringWithFormat:@"%@/src/server.js", @"/Users/nabiaz/antigravity-harness"];
        nodeTask.arguments = @[serverPath];
        [nodeTask launch];
        [NSThread sleepForTimeInterval:1.0];
    }
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        
        [app run];
    }
    return 0;
}
