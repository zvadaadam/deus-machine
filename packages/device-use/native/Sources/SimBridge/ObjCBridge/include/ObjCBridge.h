#import <Foundation/Foundation.h>

/// Wrapper for calling CoreSimulator's sendAccessibilityRequestAsync
/// which requires proper ObjC block bridging that Swift can't do safely.
NS_ASSUME_NONNULL_BEGIN

@interface SimAccessibilityBridge : NSObject

/// Fetch the accessibility tree from a SimDevice.
/// @param device The SimDevice NSObject
/// @param error Output error
/// @return The accessibility tree data (NSArray/NSDictionary), or nil on error
+ (nullable id)fetchAccessibilityFromDevice:(id)device
                                      error:(NSError **)error;

/// Send a touch event to a SimDevice via its HID subsystem.
/// @param device The SimDevice NSObject
/// @param x X coordinate (normalized 0..1)
/// @param y Y coordinate (normalized 0..1)
/// @param isDown YES for touch-down, NO for touch-up
/// @param error Output error
/// @return YES on success
+ (BOOL)sendTouchToDevice:(id)device
                        x:(double)x
                        y:(double)y
                   isDown:(BOOL)isDown
                    error:(NSError **)error;

/// Send a touch event with explicit event type (begin/move/end).
/// @param device The SimDevice NSObject
/// @param x X coordinate (normalized 0..1)
/// @param y Y coordinate (normalized 0..1)
/// @param eventType 1=begin, 6=move, 2=end (NSEvent types)
/// @param error Output error
/// @return YES on success
+ (BOOL)sendTouchToDevice:(id)device
                        x:(double)x
                        y:(double)y
                eventType:(int32_t)eventType
                    error:(NSError **)error;

/// Send a hardware button press to a SimDevice via its HID subsystem.
/// @param device The SimDevice NSObject
/// @param button Button name: "home", "lock", "volumeUp", "volumeDown"
/// @param error Output error
/// @return YES on success
+ (BOOL)sendButtonToDevice:(id)device
                    button:(NSString *)button
                     error:(NSError **)error;

/// Perform a complete tap gesture (down → move → up) on a single HID client.
/// Uses a single HID client for the entire sequence so all events are correlated
/// as the same touch. Includes an intermediate move event to match real finger behavior.
/// @param device The SimDevice NSObject
/// @param x X coordinate (normalized 0..1)
/// @param y Y coordinate (normalized 0..1)
/// @param holdDuration Seconds between touch-down and touch-up (default ~0.15)
/// @param error Output error
/// @return YES on success
+ (BOOL)sendTapToDevice:(id)device
                       x:(double)x
                       y:(double)y
            holdDuration:(double)holdDuration
                   error:(NSError **)error;

/// Send a keyboard event to a SimDevice via its HID subsystem.
/// @param device The SimDevice NSObject
/// @param keyCode HID keycode
/// @param isDown YES for key-down, NO for key-up
/// @param error Output error
/// @return YES on success
+ (BOOL)sendKeyToDevice:(id)device
                keyCode:(NSInteger)keyCode
                 isDown:(BOOL)isDown
                  error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
