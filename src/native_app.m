#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (strong, nonatomic) NSStatusItem *statusItem;
@property (strong, nonatomic) NSMenu *statusMenu;
@property (strong, nonatomic) NSTimer *pollTimer;
@property (strong, nonatomic) NSDictionary *lastStats;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
    // 1. Ensure server is running
    [self ensureServerRunning];

    // 2. Setup System Tray Menu Bar Extra
    [self setupMenuBarItem];

    // 3. Setup Native Window
    [self setupDashboardWindow];

    // 4. Start periodic background polling for status updates (every 5 seconds)
    self.pollTimer = [NSTimer scheduledTimerWithTimeInterval:5.0
                                                      target:self
                                                    selector:@selector(fetchStatsAsync)
                                                    userInfo:nil
                                                     repeats:YES];
    [self fetchStatsAsync];
}

- (void)setupMenuBarItem {
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    if (self.statusItem.button) {
        self.statusItem.button.title = @"⚡ AGY";
        self.statusItem.button.toolTip = @"Antigravity Harness (127.0.0.1:8045)";
    }

    self.statusMenu = [[NSMenu alloc] initWithTitle:@"Antigravity Harness"];
    [self rebuildStatusMenuWithStats:nil];
    self.statusItem.menu = self.statusMenu;
}

- (void)rebuildStatusMenuWithStats:(NSDictionary *)stats {
    [self.statusMenu removeAllItems];

    // Header Title
    NSMenuItem *header = [[NSMenuItem alloc] initWithTitle:@"⚡ Antigravity Harness (Port 8045)"
                                                    action:nil
                                             keyEquivalent:@""];
    header.enabled = NO;
    [self.statusMenu addItem:header];

    // Status / Active Account
    NSString *activeId = stats[@"activeAccountId"];
    NSArray *accounts = stats[@"accounts"] ? [stats[@"accounts"] allValues] : @[];
    NSDictionary *activeAcc = nil;
    if (activeId && stats[@"accounts"]) {
        activeAcc = stats[@"accounts"][activeId];
    }

    NSString *activeLabel = activeAcc ? [NSString stringWithFormat:@"● Active: %@", activeAcc[@"email"]] : @"● Status: Ready (Universal Proxy)";
    NSMenuItem *activeItem = [[NSMenuItem alloc] initWithTitle:activeLabel
                                                        action:nil
                                                 keyEquivalent:@""];
    activeItem.enabled = NO;
    [self.statusMenu addItem:activeItem];

    // If quota details exist for active account
    if (activeAcc && activeAcc[@"quotas"]) {
        NSDictionary *q = activeAcc[@"quotas"];
        NSNumber *pro = q[@"gemini_pro"];
        NSNumber *flash = q[@"gemini_flash"];
        if (pro || flash) {
            NSString *qText = [NSString stringWithFormat:@"   Pro: %@%% | Flash: %@%% remaining", 
                               pro ? pro : @100, flash ? flash : @100];
            NSMenuItem *qItem = [[NSMenuItem alloc] initWithTitle:qText action:nil keyEquivalent:@""];
            qItem.enabled = NO;
            [self.statusMenu addItem:qItem];
        }
    }

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    // Submenu: Switch Active Account
    NSMenuItem *switchItem = [[NSMenuItem alloc] initWithTitle:@"Switch Active Account"
                                                        action:nil
                                                 keyEquivalent:@""];
    NSMenu *switchSubmenu = [[NSMenu alloc] initWithTitle:@"Accounts"];
    
    if (stats[@"accounts"] && [stats[@"accounts"] count] > 0) {
        for (NSString *accId in stats[@"accounts"]) {
            NSDictionary *acc = stats[@"accounts"][accId];
            NSString *email = acc[@"email"] ?: accId;
            NSString *name = acc[@"name"] ?: @"";
            NSString *itemTitle = name.length > 0 ? [NSString stringWithFormat:@"%@ (%@)", name, email] : email;

            NSMenuItem *accMenuItem = [[NSMenuItem alloc] initWithTitle:itemTitle
                                                                 action:@selector(onSelectAccount:)
                                                          keyEquivalent:@""];
            accMenuItem.target = self;
            accMenuItem.representedObject = accId;
            if ([accId isEqualToString:activeId]) {
                accMenuItem.state = NSControlStateValueOn;
            }
            [switchSubmenu addItem:accMenuItem];
        }
    } else {
        NSMenuItem *noneItem = [[NSMenuItem alloc] initWithTitle:@"No Accounts Found" action:nil keyEquivalent:@""];
        noneItem.enabled = NO;
        [switchSubmenu addItem:noneItem];
    }
    
    [switchItem setSubmenu:switchSubmenu];
    [self.statusMenu addItem:switchItem];

    // Sync Quotas Item
    NSMenuItem *syncItem = [[NSMenuItem alloc] initWithTitle:@"🔄 Sync Live Quotas Now"
                                                      action:@selector(onSyncQuotas:)
                                               keyEquivalent:@"s"];
    syncItem.target = self;
    [self.statusMenu addItem:syncItem];

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    // Dashboard & Antigravity
    NSMenuItem *dashItem = [[NSMenuItem alloc] initWithTitle:@"Open Dashboard Window"
                                                      action:@selector(showDashboardWindow)
                                               keyEquivalent:@"d"];
    dashItem.target = self;
    [self.statusMenu addItem:dashItem];

    NSMenuItem *ideItem = [[NSMenuItem alloc] initWithTitle:@"Launch Google Antigravity"
                                                     action:@selector(onLaunchAntigravity:)
                                              keyEquivalent:@"a"];
    ideItem.target = self;
    [self.statusMenu addItem:ideItem];

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    // Quit
    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit Antigravity Harness"
                                                      action:@selector(onQuitApp:)
                                               keyEquivalent:@"q"];
    quitItem.target = self;
    [self.statusMenu addItem:quitItem];
}

- (void)setupDashboardWindow {
    NSRect frame = NSMakeRect(0, 0, 1060, 750);
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

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self.webView setValue:@NO forKey:@"drawsBackground"];

    [self.window.contentView addSubview:self.webView];

    NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:8045/dashboard"];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];

    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)showDashboardWindow {
    if (!self.window) {
        [self setupDashboardWindow];
    } else {
        [self.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
    }
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    // Hide window instead of terminating application so menu bar item stays active
    [self.window orderOut:nil];
    return NO;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    [self showDashboardWindow];
    return YES;
}

- (void)onSelectAccount:(NSMenuItem *)sender {
    NSString *accId = sender.representedObject;
    if (!accId) return;

    NSString *urlStr = [NSString stringWithFormat:@"http://127.0.0.1:8045/api/set-active-account?id=%@", accId];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlStr]];
    req.HTTPMethod = @"POST";

    [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *res, NSError *err) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self fetchStatsAsync];
            // Also notify WebView
            [self.webView reload];
        });
    }] resume];
}

- (void)onSyncQuotas:(NSMenuItem *)sender {
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1:8045/api/refresh-quotas"]];
    req.HTTPMethod = @"POST";

    [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *res, NSError *err) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self fetchStatsAsync];
            [self.webView reload];
        });
    }] resume];
}

- (void)onLaunchAntigravity:(NSMenuItem *)sender {
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1:8045/api/launch-desktop"]];
    req.HTTPMethod = @"POST";
    [[[NSURLSession sharedSession] dataTaskWithRequest:req] resume];
}

- (void)onQuitApp:(NSMenuItem *)sender {
    [NSApp terminate:nil];
}

- (void)fetchStatsAsync {
    NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:8045/api/stats"];
    [[[NSURLSession sharedSession] dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *res, NSError *err) {
        if (!data || err) return;
        NSError *jsonErr = nil;
        NSDictionary *stats = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonErr];
        if (stats && [stats isKindOfClass:[NSDictionary class]]) {
            dispatch_async(dispatch_get_main_queue(), ^{
                self.lastStats = stats;
                [self rebuildStatusMenuWithStats:stats];
            });
        }
    }] resume];
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
