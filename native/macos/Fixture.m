// Unbundled synthetic AppKit/Metal fixture. Observation API never injects input.
#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <netinet/in.h>
#import <stdatomic.h>
#import <sys/socket.h>
#import <unistd.h>
static NSDictionary *Config;
static NSWindow *Window, *Duplicate;
static NSMutableDictionary<NSString *, NSView *> *Controls;
static NSTextField *Text;
static NSSecureTextField *Secure;
static NSUInteger Clicks, Drags, Frames;
static BOOL Pressed, ShiftObserved;
static atomic_bool Active = true;
static double ContentScale = 1;
static CGRect CGWindowBounds(void) {
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
                                                                 (CGWindowID)Window.windowNumber));
    CGRect rect = CGRectZero;
    if (list.count)
        CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)list[0][(__bridge NSString *)kCGWindowBounds], &rect);
    return rect;
}
static NSDictionary *B(CGRect r) {
    return @{
        @"x" : @(r.origin.x),
        @"y" : @(r.origin.y),
        @"width" : @(r.size.width),
        @"height" : @(r.size.height)
    };
}
@interface Surface : NSView
@property BOOL drag;
@property NSPoint start;
@end
@implementation Surface
- (BOOL)isFlipped {
    return YES;
}
- (void)drawRect:(NSRect)dirty {
    [[NSColor colorWithSRGBRed:0.16 green:0.18 blue:0.24 alpha:1] setFill];
    NSRectFill(self.bounds);
}
- (void)mouseDown:(NSEvent *)e {
    if (_drag) {
        _start = [self convertPoint:e.locationInWindow fromView:nil];
        Pressed = YES;
    } else
        [super mouseDown:e];
}
- (void)mouseDragged:(NSEvent *)e {
    if (!_drag)
        [super mouseDragged:e];
}
- (void)mouseUp:(NSEvent *)e {
    if (_drag) {
        NSPoint end = [self convertPoint:e.locationInWindow fromView:nil];
        if (hypot(end.x - _start.x, end.y - _start.y) > 20)
            Drags++;
        Pressed = NO;
    } else
        [super mouseUp:e];
}
@end
@interface Animated : NSView
@property(strong) CAMetalLayer *metal;
@property(strong) id<MTLCommandQueue> queue;
@end
@implementation Animated
- (instancetype)initWithFrame:(NSRect)frame {
    if ((self = [super initWithFrame:frame])) {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (device) {
            self.wantsLayer = YES;
            _metal = [CAMetalLayer layer];
            _metal.device = device;
            _metal.pixelFormat = MTLPixelFormatBGRA8Unorm;
            _metal.framebufferOnly = YES;
            self.layer = _metal;
            _queue = [device newCommandQueue];
        }
    }
    return self;
}
- (void)tick {
    if (_metal) {
        _metal.contentsScale = Window.backingScaleFactor;
        _metal.drawableSize = CGSizeMake(self.bounds.size.width * Window.backingScaleFactor,
                                         self.bounds.size.height * Window.backingScaleFactor);
        id<CAMetalDrawable> drawable = [_metal nextDrawable];
        if (!drawable)
            return;
        MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
        pass.colorAttachments[0].texture = drawable.texture;
        pass.colorAttachments[0].loadAction = MTLLoadActionClear;
        pass.colorAttachments[0].storeAction = MTLStoreActionStore;
        pass.colorAttachments[0].clearColor =
            MTLClearColorMake((Frames / 4) % 2 ? 0.2 : 0.8, 0.6, 0.3, 1);
        id<MTLCommandBuffer> buffer = [_queue commandBuffer];
        id<MTLRenderCommandEncoder> encoder = [buffer renderCommandEncoderWithDescriptor:pass];
        [encoder endEncoding];
        [buffer presentDrawable:drawable];
        [buffer commit];
    } else
        [self setNeedsDisplay:YES];
}
- (void)drawRect:(NSRect)r {
    [[NSColor colorWithSRGBRed:(Frames / 4) % 2 ? 0.2 : 0.8 green:0.6 blue:0.3 alpha:1] setFill];
    NSRectFill(self.bounds);
}
@end
@interface Root : NSView
@end
@implementation Root
- (BOOL)isFlipped {
    return YES;
}
- (void)drawRect:(NSRect)rect {
    [[NSColor colorWithSRGBRed:0.08 green:0.09 blue:0.12 alpha:1] setFill];
    NSRectFill(self.bounds);
    [[NSColor colorWithSRGBRed:232. / 255 green:56. / 255 blue:100. / 255 alpha:1] setFill];
    NSRectFill(NSMakeRect(self.bounds.size.width - 68 * ContentScale, 24 * ContentScale,
                          44 * ContentScale, 44 * ContentScale));
}
@end
@interface Delegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
- (void)click:(id)sender;
@end
static Delegate *Owner;
static NSRect R(double x, double y, double w, double h) {
    return NSMakeRect(x * ContentScale, y * ContentScale, w * ContentScale, h * ContentScale);
}
static NSWindow *NewWindow(void) {
    NSWindow *w =
        [[NSWindow alloc] initWithContentRect:R(0, 0, 700, 560)
                                    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                              NSWindowStyleMaskResizable
                                      backing:NSBackingStoreBuffered
                                        defer:NO];
    w.releasedWhenClosed = NO;
    w.title = Config[@"title"];
    [w setFrameTopLeftPoint:NSMakePoint([Config[@"position"][@"x"] doubleValue],
                                        NSScreen.mainScreen.frame.size.height -
                                            [Config[@"position"][@"y"] doubleValue] - 40)];
    return w;
}
static NSDictionary *Snapshot(void) {
    CGRect outer = CGWindowBounds();
    double baseline = CGDisplayBounds(CGMainDisplayID()).size.height;
    NSMutableDictionary *targets = [NSMutableDictionary dictionary];
    for (NSString *name in Controls) {
        NSView *v = Controls[name];
        NSRect screen = [Window convertRectToScreen:[v convertRect:v.bounds toView:nil]];
        targets[name] = B(CGRectMake(screen.origin.x - outer.origin.x,
                                     baseline - NSMaxY(screen) - outer.origin.y, screen.size.width,
                                     screen.size.height));
    }
    NSRect content = [Window convertRectToScreen:Window.contentView.bounds];
    targets[@"marker"] =
        B(CGRectMake(content.origin.x - outer.origin.x + content.size.width - 68 * ContentScale,
                     baseline - NSMaxY(content) - outer.origin.y + 24 * ContentScale,
                     44 * ContentScale, 44 * ContentScale));
    NSScrollView *scroll = (NSScrollView *)Controls[@"scroll"];
    Animated *gpu = (Animated *)Controls[@"gpu"];
    NSMutableArray *held = [NSMutableArray array];
    if (ShiftObserved)
        [held addObject:@"Shift"];
    NSMutableArray *displays = [NSMutableArray array];
    for (NSScreen *s in NSScreen.screens)
        [displays addObject:@{@"scaleFactor" : @(s.backingScaleFactor)}];
    return @{
        @"coordinateSpace" : @"window-input",
        @"targets" : targets,
        @"clicks" : @(Clicks),
        @"text" : Text.stringValue,
        @"secureHasValue" : Secure.stringValue.length > 0 ? @YES : @NO,
        @"scrollTop" : @(scroll.contentView.bounds.origin.y),
        @"drags" : @(Drags),
        @"buttons" : @(Pressed ? 1 : 0),
        @"held" : held,
        @"animationFrames" : @(Frames),
        @"gpu" : gpu.metal != nil ? @YES : @NO,
        @"renderSurface" : gpu.metal ? @"metal" : @"native-appkit",
        @"nativeControls" : @YES,
        @"contentScale" : @(ContentScale),
        @"devicePixelRatio" : @(Window.backingScaleFactor),
        @"bounds" : B(outer),
        @"focused" : Window.isKeyWindow && NSApp.isActive ? @YES : @NO,
        @"minimized" : Window.isMiniaturized ? @YES : @NO,
        @"duplicate" : Duplicate != nil ? @YES : @NO,
        @"displays" : displays,
        @"versions" : @{@"fixture" : @"AppKit/Metal", @"version" : @"1"}
    };
}
static BOOL WriteAll(int fd, NSData *data) {
    const char *b = data.bytes;
    size_t remaining = data.length;
    while (remaining) {
        ssize_t n = write(fd, b, remaining);
        if (n <= 0)
            return NO;
        b += n;
        remaining -= n;
    }
    return YES;
}
static void Serve(int listener) {
    while (atomic_load(&Active)) {
        @autoreleasepool {
            int fd = accept(listener, NULL, NULL);
            if (fd < 0)
                continue;
            int yes = 1;
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
            struct timeval timeout = {2, 0};
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
            NSMutableData *request = [NSMutableData data];
            BOOL complete = NO;
            while (request.length < 8192) {
                char bytes[1024];
                ssize_t n = read(fd, bytes, sizeof(bytes));
                if (n <= 0)
                    break;
                [request appendBytes:bytes length:n];
                NSString *s = [[NSString alloc] initWithData:request encoding:NSUTF8StringEncoding];
                if ([s containsString:@"\r\n\r\n"]) {
                    complete = YES;
                    break;
                }
            }
            NSString *text = [[NSString alloc] initWithData:request encoding:NSUTF8StringEncoding];
            NSArray *lines = [text componentsSeparatedByString:@"\r\n"],
                    *first = [lines.firstObject componentsSeparatedByString:@" "];
            BOOL authorized = NO;
            for (NSString *line in lines) {
                NSRange split = [line rangeOfString:@":"];
                if (split.location != NSNotFound &&
                    [[line substringToIndex:split.location].lowercaseString
                        isEqual:@"authorization"]) {
                    NSString *v = [[line substringFromIndex:split.location + 1]
                        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
                    authorized = [v isEqual:[@"Bearer " stringByAppendingString:Config[@"token"]]];
                }
            }
            __block NSDictionary *body = @{};
            __block NSString *status = authorized && complete ? @"200 OK" : @"403 Forbidden";
            if (authorized && complete && first.count >= 2) {
                dispatch_sync(dispatch_get_main_queue(), ^{
                  NSString *method = first[0], *path = first[1];
                  if ([method isEqual:@"GET"] && [path isEqual:@"/state"])
                      body = Snapshot();
                  else if ([method isEqual:@"POST"]) {
                      if ([path isEqual:@"/resize"])
                          [Window setContentSize:R(0, 0, 640, 500).size];
                      else if ([path isEqual:@"/minimize"])
                          [Window miniaturize:nil];
                      else if ([path isEqual:@"/restore"]) {
                          [Window deminiaturize:nil];
                          [Window makeKeyAndOrderFront:nil];
                          [NSApp activateIgnoringOtherApps:YES];
                      } else if ([path isEqual:@"/duplicate"]) {
                          Duplicate = NewWindow();
                          [Duplicate setFrameOrigin:NSMakePoint(NSMinX(Window.frame) + 80,
                                                                NSMinY(Window.frame) - 40)];
                          [Duplicate makeKeyAndOrderFront:nil];
                      } else if ([path isEqual:@"/close-duplicate"]) {
                          [Duplicate close];
                          Duplicate = nil;
                          [Window makeKeyAndOrderFront:nil];
                      } else if ([path isEqual:@"/quit"]) {
                          dispatch_async(dispatch_get_main_queue(), ^{
                            [NSApp terminate:nil];
                          });
                      } else
                          status = @"404 Not Found";
                  } else
                      status = @"404 Not Found";
                });
            }
            NSData *json = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
            NSString *header =
                [NSString stringWithFormat:
                              @"HTTP/1.1 %@\r\nContent-Type: application/json\r\nContent-Length: "
                              @"%lu\r\nConnection: close\r\n\r\n",
                              status, (unsigned long)json.length];
            WriteAll(fd, [header dataUsingEncoding:NSUTF8StringEncoding]);
            WriteAll(fd, json);
            close(fd);
        }
    }
}
@implementation Delegate
- (void)click:(id)sender {
    Clicks++;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app {
    return YES;
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    Window = NewWindow();
    Window.delegate = self;
    Root *root = [[Root alloc] initWithFrame:R(0, 0, 700, 560)];
    Window.contentView = root;
    Controls = [NSMutableDictionary dictionary];
    NSButton *action = [[NSButton alloc] initWithFrame:R(28, 70, 110, 38)];
    action.title = @"Activate";
    action.target = self;
    action.action = @selector(click:);
    [root addSubview:action];
    Controls[@"action"] = action;
    for (int i = 0; i < 2; i++) {
        NSButton *b = [[NSButton alloc] initWithFrame:R(145 + i * 150, 70, 140, 38)];
        b.title = @"Duplicate label";
        [root addSubview:b];
    }
    Text = [[NSTextField alloc] initWithFrame:R(62, 117, 240, 38)];
    [root addSubview:Text];
    Controls[@"text"] = Text;
    Secure = [[NSSecureTextField alloc] initWithFrame:R(118, 163, 240, 38)];
    [root addSubview:Secure];
    Controls[@"secure"] = Secure;
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:R(32, 220, 240, 80)];
    Surface *document = [[Surface alloc] initWithFrame:R(0, 0, 220, 600)];
    scroll.documentView = document;
    scroll.hasVerticalScroller = YES;
    [root addSubview:scroll];
    Controls[@"scroll"] = scroll;
    Surface *drag = [[Surface alloc] initWithFrame:R(32, 310, 280, 56)];
    drag.drag = YES;
    [root addSubview:drag];
    Controls[@"drag"] = drag;
    Animated *gpu = [[Animated alloc] initWithFrame:R(450, 240, 200, 160)];
    [root addSubview:gpu];
    Controls[@"gpu"] = gpu;
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                          handler:^NSEvent *(NSEvent *event) {
                                            ShiftObserved = (event.modifierFlags &
                                                             NSEventModifierFlagShift) != 0;
                                            return event;
                                          }];
    [Window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [NSTimer scheduledTimerWithTimeInterval:1. / 15
                                    repeats:YES
                                      block:^(NSTimer *timer) {
                                        Frames++;
                                        [gpu tick];
                                      }];
    [NSTimer scheduledTimerWithTimeInterval:600
                                    repeats:NO
                                      block:^(NSTimer *t) {
                                        [NSApp terminate:nil];
                                      }];
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {.sin_len = sizeof(address),
                                  .sin_family = AF_INET,
                                  .sin_port = 0,
                                  .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        listen(listener, 8) != 0)
        exit(2);
    socklen_t length = sizeof(address);
    getsockname(listener, (struct sockaddr *)&address, &length);
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"port" : @(ntohs(address.sin_port))}
                                                   options:0
                                                     error:nil];
    [json writeToFile:Config[@"controlFile"] atomically:YES];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      Serve(listener);
    });
}
@end
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2)
            return 1;
        Config = [NSJSONSerialization
            JSONObjectWithData:[NSData
                                   dataWithContentsOfFile:[NSString
                                                              stringWithUTF8String:argv[argc - 1]]]
                       options:0
                         error:nil];
        if (!Config)
            return 1;
        ContentScale = MAX(0.5, MIN(3, [Config[@"contentScale"] doubleValue] ?: 1));
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        Owner = [Delegate new];
        NSApp.delegate = Owner;
        [NSApp run];
        atomic_store(&Active, false);
        return 0;
    }
}
