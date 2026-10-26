// Persistent, in-process macOS backend. Only public Apple APIs; no Apple Events.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <math.h>
#import <float.h>
#import <stdlib.h>
#import <string.h>
#import <unistd.h>

static void Fail(NSString *code) {
    @throw [NSException exceptionWithName:@"RelayNative" reason:code userInfo:nil];
}
static void Pump(void) { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false); }
static double Millis(void) { return NSDate.date.timeIntervalSince1970 * 1000.; }
static NSDictionary *Bounds(CGRect r) {
    return @{
        @"x" : @(r.origin.x),
        @"y" : @(r.origin.y),
        @"width" : @(r.size.width),
        @"height" : @(r.size.height)
    };
}
static CGRect RelayRect(NSDictionary *d) {
    return CGRectMake([d[@"x"] doubleValue], [d[@"y"] doubleValue], [d[@"width"] doubleValue],
                      [d[@"height"] doubleValue]);
}
static BOOL Same(CGRect a, CGRect b) {
    return fabs(a.origin.x - b.origin.x) < 0.5 && fabs(a.origin.y - b.origin.y) < 0.5 &&
           fabs(a.size.width - b.size.width) < 0.5 && fabs(a.size.height - b.size.height) < 0.5;
}
static BOOL SessionActive(void) {
    NSDictionary *s = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    return s && [s[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] &&
           [s[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue] &&
           front.processIdentifier > 0 &&
           ![front.bundleIdentifier isEqualToString:@"com.apple.loginwindow"];
}
static void SessionGuard(void) {
    if (!SessionActive())
        Fail(@"SESSION_INACTIVE");
}
static void InputGuard(void) {
    SessionGuard();
    if (!AXIsProcessTrusted())
        Fail(@"AX_REQUIRED");
}
static double Scale(CGRect r) {
    double area = 0, scale = 0;
    for (NSScreen *s in NSScreen.screens) {
        CGDirectDisplayID display = [s.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        CGRect intersection = CGRectIntersection(r, CGDisplayBounds(display));
        double current =
            CGRectIsNull(intersection) ? 0 : intersection.size.width * intersection.size.height;
        if (current > area) {
            area = current;
            scale = s.backingScaleFactor;
        }
    }
    return scale;
}
static NSArray *Windows(void) {
    NSArray *raw = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    if (!raw)
        Fail(@"TARGET_UNAVAILABLE");
    NSMutableArray *result = [NSMutableArray array];
    for (NSDictionary *item in raw) {
        CGRect r = CGRectZero;
        if ([item[(__bridge NSString *)kCGWindowLayer] intValue] != 0 ||
            !CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)item[(__bridge NSString *)kCGWindowBounds], &r) ||
            r.size.width < 20 || r.size.height < 20)
            continue;
        if (Scale(r) <= 0)
            continue;
        NSNumber *pid = item[(__bridge NSString *)kCGWindowOwnerPID];
        NSRunningApplication *app =
            [NSRunningApplication runningApplicationWithProcessIdentifier:pid.intValue];
        NSString *name = item[(__bridge NSString *)kCGWindowOwnerName] ?: @"";
        NSString *identity = app.bundleIdentifier ?: name;
        if (!identity.length)
            identity = pid.stringValue;
        [result addObject:@{
            @"id" : [item[(__bridge NSString *)kCGWindowNumber] stringValue],
            @"pid" : pid,
            @"title" : item[(__bridge NSString *)kCGWindowName] ?: @"",
            @"application" : name,
            @"applicationIdentity" : @{
                @"id" : identity,
                @"kind" : app.bundleIdentifier ? @"bundle-id"
                : name.length                  ? @"owner-name"
                                               : @"pid-only",
                @"pid" : pid
            },
            @"bounds" : Bounds(r),
            @"displayScale" : @(Scale(r))
        }];
    }
    return result;
}
static NSDictionary *Window(NSDictionary *p) {
    NSString *identifier = p[@"windowId"] ?: p[@"id"];
    for (NSDictionary *w in Windows())
        if ([w[@"id"] isEqual:identifier]) {
            if (p[@"applicationIdentity"] &&
                ![p[@"applicationIdentity"] isEqual:w[@"applicationIdentity"]])
                Fail(@"TARGET_UNAVAILABLE");
            return w;
        }
    Fail(@"TARGET_UNAVAILABLE");
    return nil;
}
static id Attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    AXError status = AXUIElementCopyAttributeValue(element, name, &value);
    if (status != kAXErrorSuccess)
        return nil;
    return CFBridgingRelease(value);
}
static BOOL AXBounds(AXUIElementRef w, CGRect *rect) {
    id position = Attribute(w, kAXPositionAttribute), size = Attribute(w, kAXSizeAttribute);
    if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID())
        return NO;
    return AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &rect->origin) &&
           AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &rect->size);
}
static id UniqueGeometry(NSArray *candidates, CGRect bounds) {
    NSMutableArray *matches = [NSMutableArray array];
    for (NSDictionary *candidate in candidates)
        if (Same(RelayRect(candidate[@"bounds"]), bounds))
            [matches addObject:candidate[@"element"]];
    if (matches.count != 1)
        Fail(matches.count ? @"AX_AMBIGUOUS" : @"AX_WINDOW_UNAVAILABLE");
    return matches.firstObject;
}
static id AXWindow(NSDictionary *window) {
    for (int attempt = 0; attempt < 3; attempt++) {
        InputGuard();
        AXUIElementRef application = AXUIElementCreateApplication([window[@"pid"] intValue]);
        AXUIElementSetMessagingTimeout(application, 0.5);
        NSArray *items = Attribute(application, kAXWindowsAttribute);
        CFRelease(application);
        NSMutableArray *candidates = [NSMutableArray array];
        for (id candidate in items) {
            AXUIElementRef ax = (__bridge AXUIElementRef)candidate;
            AXUIElementSetMessagingTimeout(ax, 0.5);
            CGRect r = CGRectZero;
            if (AXBounds(ax, &r))
                [candidates addObject:@{@"element" : candidate, @"bounds" : Bounds(r)}];
        }
        @try {
            return UniqueGeometry(candidates, RelayRect(window[@"bounds"]));
        } @catch (NSException *e) {
            // AX can temporarily omit a window while its provider handles input.
            // Retry only read-only identification; ambiguity and actions never retry.
            if (![e.reason isEqual:@"AX_WINDOW_UNAVAILABLE"] || attempt == 2)
                @throw;
            usleep(20000);
        }
    }
    Fail(@"AX_WINDOW_UNAVAILABLE");
    return nil;
}

static void Verify(NSDictionary *original, BOOL foreground) {
    InputGuard();
    NSDictionary *current = Window(original);
    if (!Same(RelayRect(original[@"bounds"]), RelayRect(current[@"bounds"])) ||
        ![original[@"displayScale"] isEqual:current[@"displayScale"]])
        Fail(@"CAPTURE_GEOMETRY");
    if (foreground) {
        pid_t owner = [original[@"pid"] intValue];
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != owner)
            Fail(@"FOCUS_FAILED");
        AXUIElementRef app = AXUIElementCreateApplication(owner);
        AXUIElementSetMessagingTimeout(app, 0.5);
        id focused = Attribute(app, kAXFocusedWindowAttribute);
        CFRelease(app);
        CGRect r = CGRectZero;
        if (!focused || !AXBounds((__bridge AXUIElementRef)focused, &r) ||
            !Same(r, RelayRect(original[@"bounds"])))
            Fail(@"FOCUS_FAILED");
        // Exact public AX identification must remain unique, including duplicate titles.
        AXWindow(original);
    }
}
static void Focus(NSDictionary *window) {
    InputGuard();
    id selected = AXWindow(window);
    NSRunningApplication *app =
        [NSRunningApplication runningApplicationWithProcessIdentifier:[window[@"pid"] intValue]];
    if (!app)
        Fail(@"FOCUS_FAILED");
    AXUIElementRef owner = AXUIElementCreateApplication([window[@"pid"] intValue]);
    AXUIElementSetMessagingTimeout(owner, 0.5);
    AXError front = AXUIElementSetAttributeValue(owner, kAXFrontmostAttribute, kCFBooleanTrue);
    CFRelease(owner);
    BOOL activated = [app activateWithOptions:0];
    if (!activated && front != kAXErrorSuccess)
        Fail(@"FOCUS_FAILED");
    AXUIElementRef ax = (__bridge AXUIElementRef)selected;
    if (AXUIElementPerformAction(ax, kAXRaiseAction) != kAXErrorSuccess)
        Fail(@"FOCUS_FAILED");
    AXUIElementSetAttributeValue(ax, kAXMainAttribute, kCFBooleanTrue);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1.];
    while ([deadline timeIntervalSinceNow] > 0) {
        @try {
            Verify(window, YES);
            return;
        } @catch (NSException *e) {
            if (![e.reason isEqualToString:@"FOCUS_FAILED"])
                @throw e;
        }
        Pump();
    }
    Fail(@"FOCUS_FAILED");
}
#include "RelayAX.inc"

// Completion blocks may arrive on arbitrary queues. Pump the caller's main run loop
// while waiting; never wait on a semaphore that would deadlock a main-queue callback.
static NSError *Await(void (^start)(void (^)(NSError *))) {
    NSMutableDictionary *state = [NSMutableDictionary dictionary];
    start(^(NSError *error) {
      @synchronized(state) {
          state[@"done"] = @YES;
          if (error)
              state[@"error"] = error;
      }
    });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:4.];
    while ([deadline timeIntervalSinceNow] > 0) {
        @synchronized(state) {
            if (state[@"done"])
                return state[@"error"];
        }
        Pump();
    }
    Fail(@"CAPTURE_TIMEOUT");
    return nil;
}
static BOOL FrameLost(SCFrameStatus status) {
    return status != SCFrameStatusComplete && status != SCFrameStatusIdle &&
           status != SCFrameStatusStarted;
}
static BOOL AlreadyStopped(NSError *error) {
    return [error.domain isEqual:SCStreamErrorDomain] &&
           error.code == SCStreamErrorAttemptToStopStreamState;
}
@interface RelayCapture : NSObject <SCStreamOutput, SCStreamDelegate> {
    CVPixelBufferRef latest;
}
@property(strong) SCStream *stream;
@property(strong) NSDictionary *window;
@property double scale;
@property double timestamp;
@property NSUInteger sequence;
@property BOOL failed;
@property(strong) NSLock *lock;
@property(strong) CIContext *context;
@end
@implementation RelayCapture
- (instancetype)init {
    if ((self = [super init])) {
        _lock = [NSLock new];
        _context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer : @NO}];
    }
    return self;
}
- (void)dealloc {
    if (latest)
        CVPixelBufferRelease(latest);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    [_lock lock];
    _failed = YES;
    if (latest) {
        CVPixelBufferRelease(latest);
        latest = NULL;
    }
    [_lock unlock];
}
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample))
        return;
    NSArray *attachments =
        (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSNumber *status = attachments.firstObject[SCStreamFrameInfoStatus];
    if (![status isKindOfClass:NSNumber.class] || FrameLost(status.integerValue)) {
        [self stream:stream didStopWithError:nil];
        return;
    }
    if (status.integerValue != SCFrameStatusComplete)
        return;
    CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (!buffer) {
        [self stream:stream didStopWithError:nil];
        return;
    }
    size_t width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer);
    if (width == 0 || height == 0 || width * height > 40000000) {
        [self stream:stream didStopWithError:nil];
        return;
    }
    [_lock lock];
    if (!_failed) {
        if (latest)
            CVPixelBufferRelease(latest);
        latest = CVPixelBufferRetain(buffer);
        _timestamp = Millis();
        _sequence++;
    }
    [_lock unlock];
}
- (void)stop {
    SCStream *s = _stream;
    _stream = nil;
    [_lock lock];
    _failed = YES;
    if (latest) {
        CVPixelBufferRelease(latest);
        latest = NULL;
    }
    [_lock unlock];
    NSError *error = s ? Await(^(void (^done)(NSError *)) {
      [s stopCaptureWithCompletionHandler:done];
    })
                       : nil;
    if (error && !AlreadyStopped(error))
        Fail(@"CAPTURE_LOST");
}
- (void)start:(NSDictionary *)w {
    __block SCShareableContent *content = nil;
    NSError *error = Await(^(void (^done)(NSError *)) {
      [SCShareableContent
          getShareableContentExcludingDesktopWindows:YES
                                 onScreenWindowsOnly:YES
                                   completionHandler:^(SCShareableContent *c, NSError *e) {
                                     content = c;
                                     done(e);
                                   }];
    });
    if (error || !content)
        Fail(CGPreflightScreenCaptureAccess() ? @"CAPTURE_UNAVAILABLE" : @"SCREEN_REQUIRED");
    SCWindow *selected = nil;
    for (SCWindow *candidate in content.windows)
        if (candidate.windowID == [w[@"id"] intValue] &&
            candidate.owningApplication.processID == [w[@"pid"] intValue])
            selected = candidate;
    if (!selected)
        Fail(@"TARGET_UNAVAILABLE");
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];
    CGRect input = RelayRect(w[@"bounds"]);
    _scale = filter.pointPixelScale;
    if (!isfinite(_scale) || _scale <= 0 ||
        fabs(_scale - [w[@"displayScale"] doubleValue]) > 0.001 ||
        fabs(filter.contentRect.size.width - input.size.width) > 1 ||
        fabs(filter.contentRect.size.height - input.size.height) > 1)
        Fail(@"CAPTURE_GEOMETRY");
    SCStreamConfiguration *config = [SCStreamConfiguration new];
    config.width = (size_t)llround(input.size.width * _scale);
    config.height = (size_t)llround(input.size.height * _scale);
    if (config.width == 0 || config.height == 0 || config.width * config.height > 40000000)
        Fail(@"CAPTURE_GEOMETRY");
    config.pixelFormat = kCVPixelFormatType_32BGRA;
    config.colorSpaceName = kCGColorSpaceSRGB;
    config.showsCursor = NO;
    config.capturesAudio = NO;
    config.ignoreShadowsSingleWindow = YES;
    config.queueDepth = 3;
    config.minimumFrameInterval = CMTimeMake(1, 15);
    _window = w;
    _stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
    NSError *outputError = nil;
    if (![_stream addStreamOutput:self
                             type:SCStreamOutputTypeScreen
               sampleHandlerQueue:dispatch_queue_create("dev.relay.capture", DISPATCH_QUEUE_SERIAL)
                            error:&outputError])
        Fail(@"CAPTURE_UNAVAILABLE");
    if (Await(^(void (^done)(NSError *)) {
          [self.stream startCaptureWithCompletionHandler:done];
        }))
        Fail(@"CAPTURE_UNAVAILABLE");
}
- (NSDictionary *)frame {
    CGRect r = RelayRect(_window[@"bounds"]);
    size_t width = llround(r.size.width * _scale), height = llround(r.size.height * _scale);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.],
           *settle = [NSDate dateWithTimeIntervalSinceNow:0.12];
    [_lock lock];
    NSUInteger previous = _sequence;
    [_lock unlock];
    CVPixelBufferRef buffer = NULL;
    double at = 0;
    while ([deadline timeIntervalSinceNow] > 0) {
        [_lock lock];
        BOOL failed = _failed;
        if (!failed && latest && CVPixelBufferGetWidth(latest) == width &&
            CVPixelBufferGetHeight(latest) == height &&
            (_sequence != previous || [settle timeIntervalSinceNow] <= 0)) {
            buffer = CVPixelBufferRetain(latest);
            at = _timestamp;
        }
        [_lock unlock];
        if (failed)
            Fail(@"CAPTURE_LOST");
        if (buffer)
            break;
        Pump();
    }
    if (!buffer)
        Fail(@"CAPTURE_TIMEOUT");
    CIImage *image = [CIImage imageWithCVPixelBuffer:buffer];
    CGImageRef cg = [_context createCGImage:image fromRect:CGRectMake(0, 0, width, height)];
    CVPixelBufferRelease(buffer);
    if (!cg)
        Fail(@"CAPTURE_LOST");
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cg];
    CGImageRelease(cg);
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png)
        Fail(@"CAPTURE_LOST");
    return @{
        @"width" : @(width),
        @"height" : @(height),
        @"bounds" : Bounds(r),
        @"captureBounds" : Bounds(r),
        @"displayScale" : @(_scale),
        @"backend" : @"macos-screencapturekit",
        @"capturedAt" : @(at),
        @"dataUrl" : [@"data:image/png;base64,"
            stringByAppendingString:[png base64EncodedStringWithOptions:0]]
    };
}
@end
static RelayCapture *Capture;
static void StopCapture(void) {
    RelayCapture *c = Capture;
    Capture = nil;
    if (c)
        [c stop];
}
static NSDictionary *CaptureWindow(NSDictionary *p) {
    SessionGuard();
    if (!CGPreflightScreenCaptureAccess())
        Fail(@"SCREEN_REQUIRED");
    NSDictionary *w = Window(p);
    if (Capture && (![Capture.window[@"id"] isEqual:w[@"id"]] ||
                    ![Capture.window[@"applicationIdentity"] isEqual:w[@"applicationIdentity"]] ||
                    !Same(RelayRect(Capture.window[@"bounds"]), RelayRect(w[@"bounds"])) ||
                    ![Capture.window[@"displayScale"] isEqual:w[@"displayScale"]]))
        StopCapture();
    if (!Capture) {
        Capture = [RelayCapture new];
        [Capture start:w];
    }
    NSDictionary *result = [Capture frame];
    SessionGuard();
    if (!CGPreflightScreenCaptureAccess())
        Fail(@"SCREEN_REQUIRED");
    NSDictionary *after = Window(p);
    if (!Same(RelayRect(w[@"bounds"]), RelayRect(after[@"bounds"])) ||
        ![w[@"displayScale"] isEqual:after[@"displayScale"]])
        Fail(@"CAPTURE_GEOMETRY");
    return result;
}

static NSMutableSet<NSNumber *> *Keys, *Buttons;
static CGEventSourceRef EventSource;
static CGEventSourceRef Source(void) {
    if (!EventSource) {
        EventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
        if (!EventSource)
            Fail(@"INPUT_REJECTED");
        CGEventSourceSetLocalEventsSuppressionInterval(EventSource, 0);
    }
    return EventSource;
}
static CGEventFlags Modifier(CGKeyCode code) {
    switch (code) {
    case 54:
        return kCGEventFlagMaskCommand | NX_DEVICERCMDKEYMASK;
    case 55:
        return kCGEventFlagMaskCommand | NX_DEVICELCMDKEYMASK;
    case 56:
        return kCGEventFlagMaskShift | NX_DEVICELSHIFTKEYMASK;
    case 60:
        return kCGEventFlagMaskShift | NX_DEVICERSHIFTKEYMASK;
    case 58:
        return kCGEventFlagMaskAlternate | NX_DEVICELALTKEYMASK;
    case 61:
        return kCGEventFlagMaskAlternate | NX_DEVICERALTKEYMASK;
    case 59:
        return kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK;
    case 62:
        return kCGEventFlagMaskControl | NX_DEVICERCTLKEYMASK;
    default:
        return 0;
    }
}
static CGEventFlags OwnedFlags(void) {
    CGEventFlags f = 0;
    for (NSNumber *code in Keys)
        f |= Modifier(code.unsignedShortValue);
    return f;
}
static NSArray<NSNumber *> *Chord(NSString *value) {
    static NSDictionary *codes;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      codes = @{
          @"a" : @0,
          @"s" : @1,
          @"d" : @2,
          @"f" : @3,
          @"h" : @4,
          @"g" : @5,
          @"z" : @6,
          @"x" : @7,
          @"c" : @8,
          @"v" : @9,
          @"b" : @11,
          @"q" : @12,
          @"w" : @13,
          @"e" : @14,
          @"r" : @15,
          @"y" : @16,
          @"t" : @17,
          @"1" : @18,
          @"2" : @19,
          @"3" : @20,
          @"4" : @21,
          @"6" : @22,
          @"5" : @23,
          @"9" : @25,
          @"7" : @26,
          @"8" : @28,
          @"0" : @29,
          @"o" : @31,
          @"u" : @32,
          @"i" : @34,
          @"p" : @35,
          @"enter" : @36,
          @"return" : @36,
          @"l" : @37,
          @"j" : @38,
          @"k" : @40,
          @"n" : @45,
          @"m" : @46,
          @"tab" : @48,
          @"space" : @49,
          @"backspace" : @51,
          @"escape" : @53,
          @"esc" : @53,
          @"command" : @55,
          @"meta" : @55,
          @"super" : @55,
          @"super_l" : @55,
          @"super_r" : @54,
          @"shift" : @56,
          @"shift_l" : @56,
          @"shift_r" : @60,
          @"alt" : @58,
          @"option" : @58,
          @"alt_l" : @58,
          @"alt_r" : @61,
          @"ctrl" : @59,
          @"control" : @59,
          @"control_l" : @59,
          @"control_r" : @62,
          @"home" : @115,
          @"pageup" : @116,
          @"delete" : @117,
          @"end" : @119,
          @"pagedown" : @121,
          @"left" : @123,
          @"arrowleft" : @123,
          @"right" : @124,
          @"arrowright" : @124,
          @"down" : @125,
          @"arrowdown" : @125,
          @"up" : @126,
          @"arrowup" : @126,
          @"f1" : @122,
          @"f2" : @120,
          @"f3" : @99,
          @"f4" : @118,
          @"f5" : @96,
          @"f6" : @97,
          @"f7" : @98,
          @"f8" : @100,
          @"f9" : @101,
          @"f10" : @109,
          @"f11" : @103,
          @"f12" : @111
      };
    });
    NSMutableArray *result = [NSMutableArray array];
    for (NSString *part in [value componentsSeparatedByString:@"+"]) {
        NSNumber *code = codes[part.lowercaseString];
        if (!code || [result containsObject:code])
            Fail(@"UNSUPPORTED_KEY");
        [result addObject:code];
    }
    if (!result.count)
        Fail(@"UNSUPPORTED_KEY");
    return result;
}
static void PostFlags(CGEventRef event, CGEventFlags flags) {
    if (!event)
        Fail(@"INPUT_REJECTED");
    if (!AXIsProcessTrusted()) {
        CFRelease(event);
        Fail(@"AX_REQUIRED");
    }
    CGEventSetIntegerValueField(event, kCGEventSourceUserData, 0x52454c4159);
    CGEventSetFlags(event, flags | kCGEventFlagMaskNonCoalesced);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}
static void Post(CGEventRef event) { PostFlags(event, OwnedFlags()); }
static void Key(CGKeyCode code, BOOL down) {
    if (down)
        [Keys addObject:@(code)];
    CGEventFlags flags = 0;
    for (NSNumber *owned in Keys)
        if (down || owned.unsignedShortValue != code)
            flags |= Modifier(owned.unsignedShortValue);
    CGEventRef event = CGEventCreateKeyboardEvent(Source(), code, down);
    PostFlags(event, flags);
    if (!down)
        [Keys removeObject:@(code)];
}
static void Mouse(CGEventType type, CGPoint point, CGMouseButton button, BOOL down, BOOL up,
                  int count) {
    if (down)
        [Buttons addObject:@(button)];
    CGEventRef e = CGEventCreateMouseEvent(Source(), type, point, button);
    if (!e)
        Fail(@"INPUT_REJECTED");
    CGEventSetIntegerValueField(e, kCGMouseEventClickState, count);
    Post(e);
    if (up)
        [Buttons removeObject:@(button)];
}
static void ExternalModifiers(void) {
    for (NSNumber *key in @[ @54, @55, @56, @58, @59, @60, @61, @62 ])
        if (CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState,
                                  key.unsignedShortValue) &&
            ![Keys containsObject:key])
            Fail(@"INPUT_BUSY");
    CGEventFlags mask = kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskShift |
                        kCGEventFlagMaskAlternate;
    if (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & mask & ~OwnedFlags())
        Fail(@"INPUT_BUSY");
}
static CGPoint RelayPoint(NSDictionary *p, NSDictionary *w, NSString *xkey, NSString *ykey) {
    NSNumber *x = p[xkey], *y = p[ykey];
    CGRect bounds = RelayRect(w[@"bounds"]);
    if (![x isKindOfClass:NSNumber.class] || ![y isKindOfClass:NSNumber.class] ||
        !isfinite(x.doubleValue) || !isfinite(y.doubleValue) || x.doubleValue < 0 ||
        y.doubleValue < 0 || x.doubleValue >= bounds.size.width ||
        y.doubleValue >= bounds.size.height)
        Fail(@"INVALID_COORDINATES");
    CGPoint point = CGPointMake(bounds.origin.x + x.doubleValue, bounds.origin.y + y.doubleValue);
    BOOL visible = NO;
    for (NSScreen *screen in NSScreen.screens) {
        CGDirectDisplayID display = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        if (CGRectContainsPoint(CGDisplayBounds(display), point))
            visible = YES;
    }
    if (!visible)
        Fail(@"INVALID_COORDINATES");
    for (NSDictionary *item in CFBridgingRelease(CGWindowListCopyWindowInfo(
             kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
             kCGNullWindowID))) {
        if ([item[(__bridge NSString *)kCGWindowLayer] integerValue] != 0 ||
            [item[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0)
            continue;
        CGRect r = CGRectZero;
        if (CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)item[(__bridge NSString *)kCGWindowBounds], &r) &&
            CGRectContainsPoint(r, point)) {
            if (![[item[(__bridge NSString *)kCGWindowNumber] stringValue] isEqual:w[@"id"]])
                Fail(@"TARGET_OBSCURED");
            break;
        }
    }
    return point;
}
static void ReleaseKeys(NSArray *values) {
    for (NSString *value in values) {
        NSArray *keys = nil;
        @try {
            keys = Chord(value);
        } @catch (NSException *e) {
            if ([e.reason isEqualToString:@"UNSUPPORTED_KEY"])
                continue;
            @throw e;
        }
        for (NSNumber *key in keys.reverseObjectEnumerator)
            Key(key.unsignedShortValue, NO);
    }
}
static void ReleaseAll(void) {
    // No false success after TCC revocation: retain ownership and block the adapter.
    if (!AXIsProcessTrusted())
        Fail(@"AX_REQUIRED");
    NSMutableSet *keys = [Keys mutableCopy];
    [keys addObjectsFromArray:@[ @0, @54, @55, @56, @58, @59, @60, @61, @62 ]];
    for (NSNumber *key in keys)
        Key(key.unsignedShortValue, NO);
    CGEventRef event = CGEventCreate(Source());
    if (!event)
        Fail(@"INPUT_REJECTED");
    CGPoint location = CGEventGetLocation(event);
    CFRelease(event);
    NSMutableSet *buttons = [Buttons mutableCopy];
    for (NSNumber *button in @[ @0, @1, @2 ])
        if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, button.intValue))
            [buttons addObject:button];
    for (NSNumber *button in buttons) {
        int b = button.intValue;
        Mouse(b == 0   ? kCGEventLeftMouseUp
              : b == 1 ? kCGEventRightMouseUp
                       : kCGEventOtherMouseUp,
              location, b, NO, YES, 1);
        // The next event must not be constructed from an earlier held-button
        // snapshot. A replacement helper shares the session source state.
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
        while (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, b) &&
               [deadline timeIntervalSinceNow] > 0)
            Pump();
        if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, b)) {
            [Buttons addObject:button];
            Fail(@"INPUT_REJECTED");
        }
    }
}
static void Input(NSDictionary *p) {
    NSString *kind = p[@"kind"], *action = p[@"action"];
    NSArray *chord = [kind isEqual:@"key"] ? Chord(p[@"key"] ?: @"")
                                           : @[]; // Validate all before posting any event.
    if ([kind isEqual:@"key"] && [action isEqual:@"up"]) {
        for (NSNumber *code in chord.reverseObjectEnumerator)
            Key(code.unsignedShortValue, NO);
        return;
    }
    InputGuard();
    ExternalModifiers();
    NSDictionary *w = Window(p);
    Focus(w);
    Verify(w, YES);
    int b = [p[@"button"] isEqual:@"right"] ? 1 : [p[@"button"] isEqual:@"middle"] ? 2 : 0;
    CGEventType down = b == 0   ? kCGEventLeftMouseDown
                       : b == 1 ? kCGEventRightMouseDown
                                : kCGEventOtherMouseDown,
                up = b == 0   ? kCGEventLeftMouseUp
                     : b == 1 ? kCGEventRightMouseUp
                              : kCGEventOtherMouseUp;
    @try {
        if ([@[ @"click", @"move", @"drag" ] containsObject:kind]) {
            if (![kind isEqual:@"move"] &&
                CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, b) &&
                ![Buttons containsObject:@(b)])
                Fail(@"INPUT_BUSY");
            CGPoint start = RelayPoint(p, w, @"x", @"y"), end = start;
            if ([kind isEqual:@"drag"])
                end = RelayPoint(p, w, @"toX", @"toY");
            Mouse(kCGEventMouseMoved, start, b, NO, NO, 0);
            if ([kind isEqual:@"click"]) {
                int count = MAX(1, MIN(3, [p[@"clickCount"] intValue]));
                for (int n = 1; n <= count; n++) {
                    Verify(w, YES);
                    Mouse(down, start, b, YES, NO, n);
                    Mouse(up, start, b, NO, YES, n);
                    usleep(70000);
                }
            } else if ([kind isEqual:@"drag"]) {
                Mouse(down, start, b, YES, NO, 1);
                double duration = p[@"durationMs"] ? [p[@"durationMs"] doubleValue] : 300;
                duration = MAX(20, MIN(120000, duration));
                for (int n = 1; n <= 40; n++) {
                    usleep((useconds_t)(duration * 1000 / 40));
                    Verify(w, YES);
                    NSMutableDictionary *next = [p mutableCopy];
                    next[@"x"] =
                        @(start.x - RelayRect(w[@"bounds"]).origin.x + (end.x - start.x) * n / 40.);
                    next[@"y"] =
                        @(start.y - RelayRect(w[@"bounds"]).origin.y + (end.y - start.y) * n / 40.);
                    CGPoint at = RelayPoint(next, w, @"x", @"y");
                    Mouse(b == 0   ? kCGEventLeftMouseDragged
                          : b == 1 ? kCGEventRightMouseDragged
                                   : kCGEventOtherMouseDragged,
                          at, b, NO, NO, 1);
                }
                Mouse(up, end, b, NO, YES, 1);
            }
        } else if ([kind isEqual:@"type"]) {
            if (OwnedFlags() || CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, 0))
                Fail(@"INPUT_BUSY");
            NSString *text = p[@"text"] ?: @"";
            for (NSUInteger i = 0; i < text.length;) {
                Verify(w, YES);
                ExternalModifiers();
                unichar chars[2] = {[text characterAtIndex:i++], 0};
                NSUInteger count = 1;
                if (CFStringIsSurrogateHighCharacter(chars[0]) && i < text.length &&
                    CFStringIsSurrogateLowCharacter([text characterAtIndex:i]))
                    chars[count++] = [text characterAtIndex:i++];
                [Keys addObject:@0];
                for (NSNumber *isDown in @[ @YES, @NO ]) {
                    CGEventRef e = CGEventCreateKeyboardEvent(Source(), 0, isDown.boolValue);
                    if (!e)
                        Fail(@"INPUT_REJECTED");
                    CGEventKeyboardSetUnicodeString(e, count, chars);
                    Post(e);
                }
                [Keys removeObject:@0];
            }
        } else if ([kind isEqual:@"key"]) {
            for (NSNumber *code in chord)
                if (CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState,
                                          code.unsignedShortValue) &&
                    ![Keys containsObject:code])
                    Fail(@"INPUT_BUSY");
            for (NSNumber *code in chord)
                Key(code.unsignedShortValue, YES);
            if (![action isEqual:@"down"]) {
                usleep((useconds_t)(MAX(0, MIN(120000, [p[@"durationMs"] doubleValue])) * 1000));
                for (NSNumber *code in chord.reverseObjectEnumerator)
                    Key(code.unsignedShortValue, NO);
            }
        } else if ([kind isEqual:@"scroll"]) {
            if (p[@"x"])
                Mouse(kCGEventMouseMoved, RelayPoint(p, w, @"x", @"y"), b, NO, NO, 0);
            double x = [p[@"deltaX"] doubleValue], y = [p[@"deltaY"] doubleValue];
            if (!isfinite(x) || !isfinite(y) || fabs(x) > 1000000 || fabs(y) > 1000000)
                Fail(@"INVALID_COORDINATES");
            Verify(w, YES);
            Post(CGEventCreateScrollWheelEvent(Source(), kCGScrollEventUnitPixel, 2, (int32_t)-y,
                                               (int32_t)-x));
        } else
            Fail(@"UNSUPPORTED_OPERATION");
    } @catch (NSException *e) {
        @try {
            ReleaseAll();
        } @catch (NSException *ignored) {
        } @
        throw e;
    }
}
static NSDictionary *Capabilities(void) {
    BOOL screen = CGPreflightScreenCaptureAccess(), ax = AXIsProcessTrusted(),
         session = SessionActive();
    return @{
        @"platform" : @"darwin",
        @"session" : @"desktop",
        @"capture" : screen && session ? @YES : @NO,
        @"input" : ax && session ? @YES : @NO,
        @"accessibility" : ax && session ? @YES : @NO,
        @"directRecording" : @NO,
        @"globalShortcuts" : @YES,
        @"windows" : Windows(),
        @"reasons" : @[
            @"Grant Screen Recording and Accessibility to Relay and its bundled helper in System Settings > Privacy & Security. Passive checks never open permission prompts.",
            @"ScreenCaptureKit captures the selected window with no backend fallback. Public AX window focus uses unique owner/geometry, never a window title or private window-number API.",
            @"Posted CGEvents are not proof of application effects. An unlocked interactive session is required; Retina, revocation, secondary displays and installed-app identity require qualification."
        ],
        @"macosBackend" : @{
            @"screenRecording" : screen ? @"granted" : @"required",
            @"accessibility" : ax ? @"granted" : @"required",
            @"interactiveSession" : session ? @YES : @NO,
            @"framework" : @"ScreenCaptureKit",
            @"minimumOS" : @"14.0",
            @"processPath" : NSProcessInfo.processInfo.arguments.firstObject ?: @"",
            @"bundleId" : NSBundle.mainBundle.bundleIdentifier ?: @"",
            @"focusIdentification" : @"public-ax-owner-geometry"
        }
    };
}
static id Selftest(void) {
    AXValidateLocator(@{@"version":@1,@"backend":@"ax",@"selector":@{@"automationId":@"fixture"}});
    if (!AXMatches(@{@"automationId":@"fixture"}, @{@"automationId":@"fixture",@"bounds":@{}}) ||
        AXMatches(@{@"automationId":@"fixture"}, @{@"automationId":@"fixture-2"})) Fail(@"BACKEND_FAILURE");
    for (NSString *field in @[@"pid",@"pointer",@"runtimeId",@"x"]) {
        BOOL invalid = NO;
        @try { AXValidateSelector(@{field:@42}); }
        @catch (NSException *e) { invalid = [e.reason isEqual:@"INVALID_REQUEST"]; }
        if (!invalid) Fail(@"BACKEND_FAILURE");
    }

    if (Chord(@"Command+Shift+K").count != 3 || Chord(@"F12").firstObject.unsignedShortValue != 111)
        Fail(@"BACKEND_FAILURE");
    BOOL rejected = NO;
    @try {
        Chord(@"Command+Invalid");
    } @catch (NSException *e) {
        rejected = [e.reason isEqual:@"UNSUPPORTED_KEY"];
    }
    if (!rejected)
        Fail(@"BACKEND_FAILURE");
    rejected = NO;
    @try {
        Chord(@"Ctrl+Control");
    } @catch (NSException *e) {
        rejected = YES;
    }
    if (!rejected)
        Fail(@"BACKEND_FAILURE");
    CGRect negative = CGRectMake(-500, 20, 200, 100);
    NSArray *candidates = @[
        @{@"element" : @"first", @"bounds" : Bounds(negative)},
        @{@"element" : @"second", @"bounds" : Bounds(CGRectMake(-200, 20, 200, 100))}
    ];
    if (![UniqueGeometry(candidates, negative) isEqual:@"first"])
        Fail(@"BACKEND_FAILURE");
    rejected = NO;
    @try {
        UniqueGeometry(@[ candidates[0], candidates[0] ], negative);
    } @catch (NSException *e) {
        rejected = [e.reason isEqual:@"AX_AMBIGUOUS"];
    }
    if (!rejected)
        Fail(@"BACKEND_FAILURE");
    rejected = NO;
    @try {
        UniqueGeometry(candidates, CGRectMake(0, 0, 10, 10));
    } @catch (NSException *e) {
        rejected = [e.reason isEqual:@"AX_WINDOW_UNAVAILABLE"];
    }
    if (!rejected)
        Fail(@"BACKEND_FAILURE");
    if (FrameLost(SCFrameStatusComplete) || FrameLost(SCFrameStatusIdle) ||
        !FrameLost(SCFrameStatusBlank) || !FrameLost(SCFrameStatusSuspended) ||
        !FrameLost(SCFrameStatusStopped))
        Fail(@"BACKEND_FAILURE");
    if (!AlreadyStopped([NSError errorWithDomain:SCStreamErrorDomain
                                            code:SCStreamErrorAttemptToStopStreamState
                                        userInfo:nil]) ||
        AlreadyStopped([NSError errorWithDomain:SCStreamErrorDomain
                                           code:SCStreamErrorInternalError
                                       userInfo:nil]))
        Fail(@"BACKEND_FAILURE");
    return @YES;
}
char *relay_macos_call(const char *method, const char *params) {
    @autoreleasepool {
        NSString *m = [NSString stringWithUTF8String:method];
        NSDictionary *p =
            [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:params]
                                                        dataUsingEncoding:NSUTF8StringEncoding]
                                            options:0
                                              error:nil];
        NSDictionary *reply;
        @try {
            static dispatch_once_t once;
            if (![m isEqual:@"selftest"])
                dispatch_once(&once, ^{
                  Keys = [NSMutableSet set];
                  Buttons = [NSMutableSet set];
                  [NSApplication sharedApplication];
                  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
                });
            id result = @YES;
            if (![p isKindOfClass:NSDictionary.class])
                Fail(@"INVALID_REQUEST");
            if ([m isEqual:@"capabilities"])
                result = Capabilities();
            else if ([m isEqual:@"inspectNativeLocator"] || [m isEqual:@"nativeElement"])
                result = AXSemantic(m, p);
            else if ([m isEqual:@"listWindows"])
                result = Windows();
            else if ([m isEqual:@"capture"])
                result = CaptureWindow(p);
            else if ([m isEqual:@"focus"])
                Focus(Window(p));
            else if ([m isEqual:@"input"])
                Input(p);
            else if ([m isEqual:@"releaseKeys"])
                ReleaseKeys(p[@"keys"] ?: @[]);
            else if ([m isEqual:@"releaseAll"]) {
                ReleaseAll();
                StopCapture();
            } else if ([m isEqual:@"releaseCapture"])
                StopCapture();
            else if ([m isEqual:@"close"]) {
                NSDictionary *w = Window(p);
                Focus(w);
                id ax = AXWindow(w);
                id button = Attribute((__bridge AXUIElementRef)ax, kAXCloseButtonAttribute);
                if (!button || AXUIElementPerformAction((__bridge AXUIElementRef)button,
                                                        kAXPressAction) != kAXErrorSuccess)
                    Fail(@"CLOSE_FAILED");
                StopCapture();
            } else if ([m isEqual:@"selftest"])
                result = Selftest();
            else
                Fail(@"UNSUPPORTED_OPERATION");
            reply = @{@"result" : result ?: @YES};
        } @catch (NSException *e) {
            if (([m isEqual:@"nativeElement"] || [m isEqual:@"inspectNativeLocator"]) && [e.reason isEqual:@"TIMEOUT"]) AXPoisoned = YES;
            if ([m isEqual:@"capture"])
                @try {
                    StopCapture();
                } @catch (NSException *ignored) {
                }
            reply = @{@"error" : [e.name isEqual:@"RelayNative"] ? e.reason : @"BACKEND_FAILURE"};
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:reply options:0 error:nil];
        NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
                              : @"{\"error\":\"BACKEND_FAILURE\"}";
        return strdup(text.UTF8String);
    }
}
void relay_macos_free(char *value) { free(value); }
