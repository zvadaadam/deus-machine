import { deviceIdentity, type HubDevice } from "@shared/types/device-hub";

export const deviceKey = (device: HubDevice) => device.platform + ":" + deviceIdentity(device);

export const deviceSetup = {
  ios: {
    label: "Install Xcode",
    url: "https://apps.apple.com/app/xcode/id497799835",
    create: "Create an iOS Simulator in Xcode’s Window → Devices and Simulators.",
  },
  android: {
    label: "Install Android Studio and create a virtual device",
    url: "https://developer.android.com/studio",
    create: "Create and start a virtual device in Android Studio’s Device Manager.",
  },
} as const;
