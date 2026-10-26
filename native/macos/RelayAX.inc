// Scoped, request-local AX objects. Included after the window/session helpers.
// Attribute reads never fall back to another process, coordinate input or titles.
static void AXStatus(AXError status) {
    if (status == kAXErrorSuccess) return;
    if (!AXIsProcessTrusted() || status == kAXErrorAPIDisabled) Fail(@"AX_REQUIRED");
    if (status == kAXErrorInvalidUIElement) Fail(@"STALE_ELEMENT");
    if (status == kAXErrorCannotComplete) Fail(@"TIMEOUT");
    if (status == kAXErrorActionUnsupported || status == kAXErrorAttributeUnsupported ||
        status == kAXErrorNotImplemented) Fail(@"UNSUPPORTED_PATTERN");
    Fail(@"BACKEND_FAILURE");
}
@interface RelayAXRequest : NSObject
@property double deadline;
@property NSUInteger visited;
@property pid_t pid;
@property id root;
@property NSDictionary *window;
@end
@implementation RelayAXRequest
@end
static void AXBudget(RelayAXRequest *r, AXUIElementRef e) {
    InputGuard();
    if (!e || CFGetTypeID(e) != AXUIElementGetTypeID()) Fail(@"STALE_ELEMENT");
    double remaining = r.deadline - Millis();
    if (remaining <= 0) Fail(@"TIMEOUT");
    AXStatus(AXUIElementSetMessagingTimeout(e, MIN(0.2, remaining / 1000.)));
    pid_t pid = 0;
    AXStatus(AXUIElementGetPid(e, &pid));
    if (pid != r.pid) Fail(@"STALE_ELEMENT");
}
static id AXRead(RelayAXRequest *r, id element, CFStringRef key) {
    AXUIElementRef e = (__bridge AXUIElementRef)element;
    AXBudget(r, e);
    CFTypeRef value = NULL;
    AXError status = AXUIElementCopyAttributeValue(e, key, &value);
    if (status == kAXErrorAttributeUnsupported || status == kAXErrorNoValue) return nil;
    AXStatus(status);
    return CFBridgingRelease(value);
}
static NSString *AXText(id value) {
    return [value isKindOfClass:NSString.class] ? value : @"";
}
static NSString *AXShort(id value) {
    NSString *text = AXText(value);
    return text.length > 512 ? [text substringToIndex:512] : text;
}
static BOOL AXEqual(id a, id b) {
    return a && b && CFEqual((__bridge CFTypeRef)a, (__bridge CFTypeRef)b);
}
static NSArray *AXArray(id value) {
    if (!value) return @[];
    if (![value isKindOfClass:NSArray.class] || [value count] > 2048) Fail(@"SEARCH_LIMIT");
    for (id item in value)
        if (CFGetTypeID((__bridge CFTypeRef)item) != AXUIElementGetTypeID()) Fail(@"BACKEND_FAILURE");
    return value;
}
static CGRect AXRect(RelayAXRequest *r, id e) {
    id p = AXRead(r, e, kAXPositionAttribute), s = AXRead(r, e, kAXSizeAttribute);
    CGRect rect = CGRectZero;
    if (!p || !s) return rect;
    if (CFGetTypeID((__bridge CFTypeRef)p) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)s) != AXValueGetTypeID() ||
        !AXValueGetValue((__bridge AXValueRef)p, kAXValueCGPointType, &rect.origin) ||
        !AXValueGetValue((__bridge AXValueRef)s, kAXValueCGSizeType, &rect.size) ||
        !isfinite(rect.origin.x) || !isfinite(rect.origin.y) ||
        !isfinite(rect.size.width) || !isfinite(rect.size.height)) Fail(@"BACKEND_FAILURE");
    return rect;
}
static NSDictionary *AXRoles(void) {
    return @{@"AXButton":@"button", @"AXCheckBox":@"checkbox", @"AXComboBox":@"combobox",
             @"AXTextField":@"edit", @"AXTextArea":@"edit", @"AXStaticText":@"text",
             @"AXList":@"list", @"AXRow":@"listitem", @"AXCell":@"listitem",
             @"AXMenuItem":@"menuitem", @"AXTabGroup":@"tab", @"AXRadioButton":@"tabitem",
             @"AXOutline":@"tree", @"AXWindow":@"window", @"AXGroup":@"pane"};
}
static void AXValidateSelector(id selector) {
    if (![selector isKindOfClass:NSDictionary.class] || ![selector count] || [selector count] > 4)
        Fail(@"INVALID_REQUEST");
    for (NSString *key in selector) {
        id value = selector[key];
        if (![@[@"automationId",@"name",@"controlType",@"className"] containsObject:key] ||
            ![value isKindOfClass:NSString.class] || [value length] > 512 ||
            (![key isEqual:@"name"] && ![value length])) Fail(@"INVALID_REQUEST");
        if ([key isEqual:@"controlType"] &&
            ![@[@"button",@"edit",@"text",@"checkbox",@"combobox",@"list",@"listitem",
                @"menuitem",@"tab",@"tabitem",@"tree",@"treeitem",@"window",@"pane",@"custom"] containsObject:value])
            Fail(@"INVALID_REQUEST");
    }
}
static void AXValidateLocator(id locator) {
    if (![locator isKindOfClass:NSDictionary.class] || ![locator[@"version"] isEqual:@1] ||
        ![locator[@"backend"] isEqual:@"ax"]) Fail(@"INVALID_REQUEST");
    for (NSString *key in locator)
        if (![@[@"version",@"backend",@"selector",@"ancestors"] containsObject:key]) Fail(@"INVALID_REQUEST");
    AXValidateSelector(locator[@"selector"]);
    if (locator[@"ancestors"] && (![locator[@"ancestors"] isKindOfClass:NSArray.class] ||
                                  [locator[@"ancestors"] count] > 8)) Fail(@"INVALID_REQUEST");
    for (id selector in locator[@"ancestors"]) AXValidateSelector(selector);
}
static BOOL AXMatches(NSDictionary *selector, NSDictionary *metadata) {
    for (NSString *key in selector)
        if (![selector[key] isEqual:metadata[key]]) return NO;
    return YES;
}
static NSDictionary *AXMetadata(RelayAXRequest *r, id element) {
    NSString *subrole = AXText(AXRead(r, element, kAXSubroleAttribute));
    BOOL secure = [subrole isEqual:@"AXSecureTextField"];
    NSString *role = AXText(AXRead(r, element, kAXRoleAttribute));
    // Check secure subrole before asking for any accessible label. Never read Value here.
    NSString *name = @"";
    if (!secure) {
        name = AXShort(AXRead(r, element, kAXTitleAttribute));
        if (!name.length) name = AXShort(AXRead(r, element, kAXDescriptionAttribute));
    }
    CGRect rect = AXRect(r, element);
    BOOL visible = rect.size.width > 0 && rect.size.height > 0 &&
                   CGRectIntersectsRect(rect, RelayRect(r.window[@"bounds"]));
    id enabled = AXRead(r, element, kAXEnabledAttribute);
    if (enabled && ![enabled isKindOfClass:NSNumber.class]) Fail(@"BACKEND_FAILURE");
    NSString *type = AXRoles()[role] ?: @"unknown";
    NSMutableArray *actions = [NSMutableArray array];
    if (!secure) {
        [actions addObject:@"read"];
        CFArrayRef names = NULL;
        AXBudget(r, (__bridge AXUIElementRef)element);
        AXError status = AXUIElementCopyActionNames((__bridge AXUIElementRef)element, &names);
        if (status != kAXErrorNotImplemented && status != kAXErrorActionUnsupported) AXStatus(status);
        NSArray *supported = CFBridgingRelease(names);
        if ([supported containsObject:(__bridge NSString *)kAXPressAction]) [actions addObject:@"invoke"];
        Boolean settable = false;
        AXBudget(r, (__bridge AXUIElementRef)element);
        status = AXUIElementIsAttributeSettable((__bridge AXUIElementRef)element, kAXValueAttribute, &settable);
        if (status != kAXErrorAttributeUnsupported && status != kAXErrorNoValue) AXStatus(status);
        if (settable && [@[@"edit",@"combobox"] containsObject:type]) [actions addObject:@"setValue"];
        settable = false;
        AXBudget(r, (__bridge AXUIElementRef)element);
        status = AXUIElementIsAttributeSettable((__bridge AXUIElementRef)element, kAXSelectedAttribute, &settable);
        if (status != kAXErrorAttributeUnsupported && status != kAXErrorNoValue) AXStatus(status);
        if (settable && [@[@"listitem",@"tabitem",@"treeitem"] containsObject:type]) [actions addObject:@"select"];
    }
    return @{@"automationId":AXShort(AXRead(r, element, kAXIdentifierAttribute)),
             @"name":name, @"className":role, @"controlType":type,
             @"enabled":enabled ?: @NO, @"secure":@(secure), @"offscreen":@(!visible),
             @"virtualized":@NO, @"actions":actions, @"bounds":Bounds(rect)};
}
static void AXOwned(RelayAXRequest *r, id element) {
    id current = element;
    for (int depth = 0; current && depth < 64; depth++) {
        AXBudget(r, (__bridge AXUIElementRef)current);
        if (AXEqual(current, r.root)) return;
        current = AXRead(r, current, kAXParentAttribute);
    }
    Fail(@"STALE_ELEMENT");
}
static NSArray *AXFind(RelayAXRequest *r, id scope, NSDictionary *selector, NSDictionary *point) {
    NSMutableArray *stack = [NSMutableArray arrayWithObject:@{@"e":scope,@"depth":@0}],
                   *seen = [NSMutableArray array], *matches = [NSMutableArray array];
    while (stack.count) {
        NSDictionary *entry = stack.lastObject;
        [stack removeLastObject];
        id element = entry[@"e"];
        if (entry[@"depth"] && AXEqual(element, scope)) Fail(@"SEARCH_LIMIT");
        for (id previous in seen) if (AXEqual(previous, element)) Fail(@"SEARCH_LIMIT");
        [seen addObject:element];
        if (++r.visited > 2048 || [entry[@"depth"] intValue] > 40) Fail(@"SEARCH_LIMIT");
        AXOwned(r, element);
        NSDictionary *metadata = AXMetadata(r, element);
        BOOL match = selector && AXMatches(selector, metadata);
        if (point) match = ![metadata[@"offscreen"] boolValue] &&
            CGRectContainsPoint(RelayRect(metadata[@"bounds"]), CGPointMake([point[@"x"] doubleValue], [point[@"y"] doubleValue]));
        if (match) [matches addObject:@{@"e":element,@"metadata":metadata}];
        for (id child in AXArray(AXRead(r, element, kAXChildrenAttribute)))
            [stack addObject:@{@"e":child,@"depth":@([entry[@"depth"] intValue] + 1)}];
    }
    return matches;
}
static id AXRoot(RelayAXRequest *r) {
    AXUIElementRef app = AXUIElementCreateApplication(r.pid);
    id application = CFBridgingRelease(app);
    NSMutableArray *matches = [NSMutableArray array];
    NSArray *windows = AXArray(AXRead(r, application, kAXWindowsAttribute));
    for (id window in windows) {
        CGRect rect = AXRect(r, window);
        if (Same(rect, RelayRect(r.window[@"bounds"]))) [matches addObject:window];
    }
    if (matches.count != 1) Fail(matches.count ? @"AX_AMBIGUOUS" : @"AX_WINDOW_UNAVAILABLE");
    id root = matches.firstObject;
    // A sheet or another modal window cannot be bypassed by acting on its parent.
    if (AXArray(AXRead(r, root, kAXSheetsAttribute)).count) Fail(@"MODAL_BLOCKED");
    for (id window in windows)
        if (!AXEqual(root, window) && [AXRead(r, window, kAXModalAttribute) boolValue]) Fail(@"MODAL_BLOCKED");
    return root;
}
static NSDictionary *AXLocator(NSDictionary *metadata) {
    NSMutableDictionary *selector = [NSMutableDictionary dictionary];
    if ([metadata[@"automationId"] length]) selector[@"automationId"] = metadata[@"automationId"];
    else {
        if ([metadata[@"name"] length]) selector[@"name"] = metadata[@"name"];
        if ([metadata[@"className"] length]) selector[@"className"] = metadata[@"className"];
    }
    if (![metadata[@"controlType"] isEqual:@"unknown"]) selector[@"controlType"] = metadata[@"controlType"];
    if (!selector.count) Fail(@"UNSUPPORTED_PATTERN");
    return @{@"version":@1,@"backend":@"ax",@"selector":selector};
}
static BOOL AXPoisoned;
static id AXSemantic(NSString *method, NSDictionary *p) {
    if (AXPoisoned) Fail(@"TIMEOUT");
    InputGuard();
    RelayAXRequest *r = [RelayAXRequest new];
    r.deadline = Millis() + 4000;
    r.window = Window(p);
    r.pid = [r.window[@"pid"] intValue];
    r.root = AXRoot(r);
    NSDictionary *locator = p[@"locator"], *point = p[@"point"];
    if ((locator != nil) == (point != nil)) Fail(@"INVALID_REQUEST");
    id scope = r.root;
    if (locator) {
        AXValidateLocator(locator);
        for (NSDictionary *selector in locator[@"ancestors"]) {
            NSArray *found = AXFind(r, scope, selector, nil);
            if (found.count != 1) Fail(found.count ? @"AMBIGUOUS_ELEMENT" : @"ELEMENT_NOT_FOUND");
            scope = found[0][@"e"];
        }
    } else {
        if (![method isEqual:@"inspectNativeLocator"] || ![point isKindOfClass:NSDictionary.class] ||
            [point count] != 2 || ![point[@"x"] isKindOfClass:NSNumber.class] ||
            ![point[@"y"] isKindOfClass:NSNumber.class] ||
            !isfinite([point[@"x"] doubleValue]) || !isfinite([point[@"y"] doubleValue]) ||
            ![p[@"expectedBounds"] isEqual:r.window[@"bounds"]]) Fail(@"CAPTURE_GEOMETRY");
    }
    NSArray *found = AXFind(r, scope, locator[@"selector"], point);
    if (point && found.count) {
        double smallest = DBL_MAX;
        NSMutableArray *best = [NSMutableArray array];
        for (NSDictionary *candidate in found) {
            CGRect rect = RelayRect(candidate[@"metadata"][@"bounds"]);
            double area = rect.size.width * rect.size.height;
            if (area < smallest) { [best removeAllObjects]; smallest = area; }
            if (area == smallest) [best addObject:candidate];
        }
        found = best;
        if (found.count == 1) {
            locator = AXLocator(found[0][@"metadata"]);
            found = AXFind(r, r.root, locator[@"selector"], nil);
        }
    }
    NSString *status = found.count == 0 ? @"missing" : found.count == 1 ? @"unique" : @"ambiguous";
    if ([method isEqual:@"inspectNativeLocator"]) {
        if (found.count != 1) return @{@"status":status,@"count":@(found.count)};
        NSMutableDictionary *metadata = [found[0][@"metadata"] mutableCopy];
        metadata[@"locator"] = locator;
        return @{@"status":status,@"count":@1,@"element":metadata};
    }
    if (found.count != 1) Fail(found.count ? @"AMBIGUOUS_ELEMENT" : @"ELEMENT_NOT_FOUND");
    id element = found[0][@"e"];
    NSDictionary *metadata = AXMetadata(r, element);
    NSString *action = p[@"action"];
    if ([metadata[@"secure"] boolValue]) Fail(@"SECURE_ELEMENT");
    if ([metadata[@"offscreen"] boolValue]) Fail(@"ELEMENT_OFFSCREEN");
    if (![action isEqual:@"read"] && ![metadata[@"enabled"] boolValue]) Fail(@"ELEMENT_DISABLED");
    if (![metadata[@"actions"] containsObject:action]) Fail(@"UNSUPPORTED_PATTERN");
    AXOwned(r, element);
    // Revalidate current window, modal state and ownership immediately before the action.
    if (!Same(RelayRect(Window(p)[@"bounds"]), RelayRect(r.window[@"bounds"])) || !AXEqual(AXRoot(r), r.root))
        Fail(@"STALE_ELEMENT");
    AXBudget(r, (__bridge AXUIElementRef)element);
    if ([action isEqual:@"read"]) {
        id value = AXRead(r, element, kAXValueAttribute);
        if (!value) return metadata[@"name"];
        if ([value isKindOfClass:NSString.class] && [value length] <= 262144) return value;
        if ([value isKindOfClass:NSNumber.class]) return [value stringValue];
        Fail(@"UNSUPPORTED_PATTERN");
    } else if ([action isEqual:@"invoke"])
        AXStatus(AXUIElementPerformAction((__bridge AXUIElementRef)element, kAXPressAction));
    else if ([action isEqual:@"setValue"]) {
        if (![p[@"text"] isKindOfClass:NSString.class] || [p[@"text"] length] > 65536) Fail(@"INVALID_REQUEST");
        AXStatus(AXUIElementSetAttributeValue((__bridge AXUIElementRef)element, kAXValueAttribute, (__bridge CFStringRef)p[@"text"]));
    } else if ([action isEqual:@"select"])
        AXStatus(AXUIElementSetAttributeValue((__bridge AXUIElementRef)element, kAXSelectedAttribute, kCFBooleanTrue));
    else Fail(@"UNSUPPORTED_PATTERN");
    return @YES;
}
