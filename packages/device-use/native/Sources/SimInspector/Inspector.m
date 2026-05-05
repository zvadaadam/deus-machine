#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <unistd.h>

static int sServerFd = -1;
static id sActiveObserver;

static NSDictionary *rect_dict(CGRect rect) {
    return @{
        @"x": @(rect.origin.x),
        @"y": @(rect.origin.y),
        @"width": @(rect.size.width),
        @"height": @(rect.size.height),
    };
}

static NSString *short_desc(id value) {
    if (!value) return nil;
    NSString *desc = [[value description] stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
    if (desc.length > 160) desc = [desc substringToIndex:160];
    return desc;
}

static NSArray<NSString *> *safe_keys(void) {
    static NSArray<NSString *> *keys;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        keys = @[
            @"accessibilityLabel",
            @"accessibilityIdentifier",
            @"backgroundColor",
            @"clipsToBounds",
            @"contentMode",
            @"currentTitle",
            @"font",
            @"isOpaque",
            @"isSelected",
            @"placeholder",
            @"text",
            @"textColor",
            @"tintColor",
            @"titleLabel",
        ];
    });
    return keys;
}

static BOOL is_secure_text_entry(UIView *view) {
    if (![view respondsToSelector:NSSelectorFromString(@"isSecureTextEntry")]) return NO;
    @try {
        return [[view valueForKey:@"secureTextEntry"] boolValue];
    } @catch (NSException *ex) {
        return NO;
    }
}

static NSDictionary *properties_for_view(UIView *view) {
    NSMutableDictionary *props = [NSMutableDictionary dictionary];
    BOOL secureTextEntry = is_secure_text_entry(view);
    for (NSString *key in safe_keys()) {
        SEL selector = NSSelectorFromString(key);
        if (![view respondsToSelector:selector]) continue;
        @try {
            if (secureTextEntry && [key isEqualToString:@"text"]) {
                props[key] = @"••••";
                continue;
            }
            id value = [view valueForKey:key];
            NSString *desc = short_desc(value);
            if (desc.length > 0) props[key] = desc;
        } @catch (NSException *ex) {
        }
    }
    return props;
}

static NSDictionary *properties_for_layer(CALayer *layer) {
    NSMutableDictionary *props = [NSMutableDictionary dictionary];
    props[@"bounds"] = NSStringFromCGRect(layer.bounds);
    props[@"position"] = NSStringFromCGPoint(layer.position);
    props[@"anchorPoint"] = NSStringFromCGPoint(layer.anchorPoint);
    props[@"opacity"] = short_desc(@(layer.opacity));
    props[@"hidden"] = short_desc(@(layer.hidden));
    props[@"masksToBounds"] = short_desc(@(layer.masksToBounds));
    props[@"cornerRadius"] = short_desc(@(layer.cornerRadius));
    if (layer.name.length > 0) props[@"name"] = layer.name;
    if (layer.backgroundColor) props[@"backgroundColor"] = short_desc((__bridge id)layer.backgroundColor);
    if (layer.borderColor) props[@"borderColor"] = short_desc((__bridge id)layer.borderColor);
    if (layer.borderWidth > 0) props[@"borderWidth"] = short_desc(@(layer.borderWidth));
    if (layer.shadowOpacity > 0) props[@"shadowOpacity"] = short_desc(@(layer.shadowOpacity));
    if (layer.contents) props[@"contents"] = short_desc(layer.contents);
    return props;
}

static NSDictionary *node_for_layer(CALayer *layer, UIView *ownerView, NSString *parentId, NSInteger index) {
    NSString *nodeId = [NSString stringWithFormat:@"layer-%p", layer];
    CGRect rectInView = [ownerView.layer convertRect:layer.bounds fromLayer:layer];
    CGRect screenRect = [ownerView convertRect:rectInView toView:nil];
    NSDictionary *props = properties_for_layer(layer);

    NSMutableArray *children = [NSMutableArray arrayWithCapacity:layer.sublayers.count];
    NSInteger childIndex = 0;
    for (CALayer *sublayer in layer.sublayers) {
        [children addObject:node_for_layer(sublayer, ownerView, nodeId, childIndex++)];
    }

    NSMutableDictionary *node = [@{
        @"id": nodeId,
        @"parentId": parentId,
        @"className": NSStringFromClass([layer class]),
        @"frame": rect_dict(layer.frame),
        @"screenRect": rect_dict(screenRect),
        @"alpha": @(layer.opacity),
        @"hidden": @(layer.hidden),
        @"userInteractionEnabled": @NO,
        @"properties": props,
        @"children": children,
    } mutableCopy];

    NSString *label = layer.name.length > 0 ? layer.name : [NSString stringWithFormat:@"Layer %ld", (long)index];
    node[@"label"] = label;
    return node;
}

static NSDictionary *node_for_view(UIView *view, NSString *parentId) {
    NSString *nodeId = [NSString stringWithFormat:@"%p", view];
    CGRect screenRect = [view convertRect:view.bounds toView:nil];
    NSDictionary *props = properties_for_view(view);

    NSMutableArray *children = [NSMutableArray arrayWithCapacity:view.subviews.count];
    for (UIView *subview in view.subviews) {
        [children addObject:node_for_view(subview, nodeId)];
    }

    NSInteger layerIndex = 0;
    for (CALayer *sublayer in view.layer.sublayers) {
        if ([sublayer.delegate isKindOfClass:UIView.class]) continue;
        if (sublayer.bounds.size.width <= 0 || sublayer.bounds.size.height <= 0 || sublayer.opacity <= 0.01 || sublayer.hidden) continue;
        [children addObject:node_for_layer(sublayer, view, nodeId, layerIndex++)];
    }

    NSMutableDictionary *node = [@{
        @"id": nodeId,
        @"className": NSStringFromClass([view class]),
        @"frame": rect_dict(view.frame),
        @"screenRect": rect_dict(screenRect),
        @"alpha": @(view.alpha),
        @"hidden": @(view.isHidden),
        @"userInteractionEnabled": @(view.userInteractionEnabled),
        @"children": children,
    } mutableCopy];

    if (parentId) node[@"parentId"] = parentId;
    if (props.count > 0) node[@"properties"] = props;
    NSString *label = props[@"accessibilityLabel"] ?: props[@"text"] ?: props[@"currentTitle"];
    if (label.length > 0) node[@"label"] = label;
    NSString *identifier = props[@"accessibilityIdentifier"];
    if (identifier.length > 0) node[@"identifier"] = identifier;
    return node;
}

static NSDictionary *snapshot_payload(void) {
    UIApplication *app = UIApplication.sharedApplication;
    NSMutableArray *roots = [NSMutableArray array];
    for (UIScene *scene in app.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        UIWindowScene *windowScene = (UIWindowScene *)scene;
        for (UIWindow *window in windowScene.windows) {
            [roots addObject:node_for_view(window, nil)];
        }
    }

    return @{
        @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
        @"pid": @((int)getpid()),
        @"timestamp": @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0)),
        @"roots": roots,
    };
}

static NSData *json_line(NSDictionary *payload) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    NSMutableData *line = [NSMutableData dataWithData:json ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding]];
    const char newline = '\n';
    [line appendBytes:&newline length:1];
    return line;
}

static NSDictionary *handle_request(NSDictionary *request) {
    NSString *command = request[@"command"];
    if ([command isEqualToString:@"ping"]) {
        return @{@"ok": @YES, @"data": @{@"pid": @((int)getpid())}};
    }
    if ([command isEqualToString:@"snapshot"]) {
        __block NSDictionary *payload = nil;
        if (NSThread.isMainThread) {
            payload = snapshot_payload();
        } else {
            dispatch_sync(dispatch_get_main_queue(), ^{ payload = snapshot_payload(); });
        }
        return @{@"ok": @YES, @"data": payload ?: @{}};
    }
    return @{@"ok": @NO, @"error": @"unknown command"};
}

static void handle_client(int clientFd) {
    @autoreleasepool {
        NSMutableData *input = [NSMutableData data];
        char buffer[4096];
        ssize_t count = 0;
        while ((count = read(clientFd, buffer, sizeof(buffer))) > 0) {
            [input appendBytes:buffer length:(NSUInteger)count];
            if (memchr(buffer, '\n', (size_t)count)) break;
            if (input.length > 1024 * 1024) break;
        }

        NSDictionary *response = nil;
        NSError *error = nil;
        id parsed = input.length > 0 ? [NSJSONSerialization JSONObjectWithData:input options:0 error:&error] : nil;
        if ([parsed isKindOfClass:NSDictionary.class]) {
            response = handle_request((NSDictionary *)parsed);
        } else {
            response = @{@"ok": @NO, @"error": error.localizedDescription ?: @"invalid json"};
        }

        NSData *output = json_line(response);
        write(clientFd, output.bytes, output.length);
        close(clientFd);
    }
}

static NSString *socket_path(void) {
    const char *envPath = getenv("DEUS_SIMINSPECTOR_SOCKET");
    if (envPath && strlen(envPath) > 0) return [NSString stringWithUTF8String:envPath];
    return [NSString stringWithFormat:@"/tmp/deus-siminspector-%d.sock", getpid()];
}

static void start_server(void) {
    if (sServerFd >= 0) return;
    NSString *path = socket_path();
    if (path.length >= sizeof(((struct sockaddr_un *)0)->sun_path)) return;

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path.UTF8String, sizeof(addr.sun_path) - 1);
    unlink(addr.sun_path);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 8) != 0) {
        close(fd);
        return;
    }

    sServerFd = fd;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        while (sServerFd >= 0) {
            int clientFd = accept(sServerFd, NULL, NULL);
            if (clientFd < 0) continue;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ handle_client(clientFd); });
        }
    });
}

__attribute__((constructor))
static void inspector_init(void) {
    sActiveObserver = [NSNotificationCenter.defaultCenter
        addObserverForName:UIApplicationDidBecomeActiveNotification
        object:nil
        queue:nil
        usingBlock:^(__unused NSNotification *note) {
            dispatch_async(dispatch_get_main_queue(), ^{ start_server(); });
        }];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        start_server();
    });
}
