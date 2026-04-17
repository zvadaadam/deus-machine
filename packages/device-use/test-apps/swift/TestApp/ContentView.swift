import SwiftUI

struct ContentView: View {
    @State private var email = ""
    @State private var password = ""
    @State private var isLoggedIn = false
    @State private var isLoading = false
    @State private var showError = false
    @State private var selectedTab = "home"
    @State private var deepLinkReceived: String?

    var body: some View {
        Group {
            if isLoading {
                LoadingView()
            } else if isLoggedIn {
                TabsView(email: email, selectedTab: $selectedTab, onLogout: {
                    isLoggedIn = false
                    isLoading = false
                    email = ""
                    password = ""
                    selectedTab = "home"
                    deepLinkReceived = nil
                })
                .overlay(alignment: .top) {
                    if let url = deepLinkReceived {
                        DeepLinkBanner(url: url) {
                            deepLinkReceived = nil
                        }
                    }
                }
            } else {
                LoginView(
                    email: $email,
                    password: $password,
                    showError: $showError,
                    onLogin: {
                        if email.contains("@") && password.count >= 4 {
                            isLoading = true
                            showError = false
                            DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
                                isLoading = false
                                isLoggedIn = true
                            }
                        } else {
                            showError = true
                        }
                    }
                )
            }
        }
        .onOpenURL { url in
            deepLinkReceived = url.absoluteString
            guard url.scheme == "testapp" else { return }
            if let tab = url.host {
                selectedTab = tab
            }
            // Auto-login for deep links
            if !isLoggedIn && !isLoading {
                email = "deeplink@test.com"
                isLoggedIn = true
            }
        }
    }
}

// MARK: - Loading Screen

struct LoadingView: View {
    var body: some View {
        VStack(spacing: 20) {
            ProgressView()
                .scaleEffect(1.5)
                .accessibilityIdentifier("LoadingSpinner")

            Text("Logging in...")
                .foregroundColor(.secondary)
                .accessibilityIdentifier("LoadingText")
        }
    }
}

// MARK: - Deep Link Banner

struct DeepLinkBanner: View {
    let url: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "link")
            Text("Deep link: \(url)")
                .font(.caption)
                .lineLimit(1)
                .accessibilityIdentifier("DeepLinkLabel")
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill")
            }
            .accessibilityIdentifier("DismissDeepLinkButton")
        }
        .padding(10)
        .background(Color.blue.opacity(0.1))
        .cornerRadius(8)
        .padding(.horizontal)
        .padding(.top, 4)
    }
}

// MARK: - Login Screen

struct LoginView: View {
    @Binding var email: String
    @Binding var password: String
    @Binding var showError: Bool
    let onLogin: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Text("Welcome")
                .font(.largeTitle)
                .fontWeight(.bold)
                .accessibilityIdentifier("WelcomeTitle")

            VStack(spacing: 16) {
                TextField("Email", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.emailAddress)
                    .autocapitalization(.none)
                    .accessibilityIdentifier("EmailField")

                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
                    .accessibilityIdentifier("PasswordField")
            }
            .padding(.horizontal, 32)

            if showError {
                Text("Invalid email or password (min 4 chars)")
                    .foregroundColor(.red)
                    .font(.caption)
                    .accessibilityIdentifier("ErrorMessage")
            }

            Button(action: onLogin) {
                Text("Log In")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(10)
            }
            .padding(.horizontal, 32)
            .accessibilityIdentifier("LoginButton")

            Button("Forgot Password?") {}
                .font(.footnote)
                .accessibilityIdentifier("ForgotPasswordButton")
        }
        .padding()
    }
}

// MARK: - Tab View (after login)

struct TabsView: View {
    let email: String
    @Binding var selectedTab: String
    let onLogout: () -> Void

    var body: some View {
        TabView(selection: $selectedTab) {
            DashboardTab(email: email, onLogout: onLogout)
                .tabItem {
                    Label("Home", systemImage: "house")
                }
                .tag("home")
                .accessibilityIdentifier("HomeTab")

            SettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
                .tag("settings")
                .accessibilityIdentifier("SettingsTab")

            FormTab()
                .tabItem {
                    Label("Form", systemImage: "doc.text")
                }
                .tag("form")
                .accessibilityIdentifier("FormTab")
        }
    }
}

// MARK: - Dashboard Tab

struct DashboardTab: View {
    let email: String
    let onLogout: () -> Void

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 64))
                        .foregroundColor(.green)
                        .accessibilityIdentifier("SuccessIcon")

                    Text("Dashboard")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .accessibilityIdentifier("DashboardTitle")

                    Text("Logged in as \(email)")
                        .foregroundColor(.secondary)
                        .accessibilityIdentifier("LoggedInLabel")

                    Button("Log Out", action: onLogout)
                        .foregroundColor(.red)
                        .accessibilityIdentifier("LogoutButton")

                    // Cards with tappable items
                    VStack(spacing: 12) {
                        CardRow(icon: "person.fill", title: "Profile", subtitle: "Edit your info")
                            .accessibilityIdentifier("ProfileCard")
                        CardRow(icon: "bell.fill", title: "Notifications", subtitle: "3 unread")
                            .accessibilityIdentifier("NotificationsCard")
                        CardRow(icon: "star.fill", title: "Favorites", subtitle: "12 items")
                            .accessibilityIdentifier("FavoritesCard")
                    }
                    .padding(.horizontal)

                    Spacer(minLength: 100)
                }
                .padding(.top, 20)
            }
            .navigationTitle("Home")
        }
    }
}

struct CardRow: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundColor(.blue)
                .frame(width: 40)

            VStack(alignment: .leading) {
                Text(title)
                    .font(.headline)
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .foregroundColor(.gray)
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

// MARK: - Settings Tab (toggles, sliders, pickers)

struct SettingsTab: View {
    @State private var darkMode = false
    @State private var notifications = true
    @State private var fontSize: Double = 16
    @State private var language = "English"

    let languages = ["English", "Spanish", "French", "German", "Japanese"]

    var body: some View {
        NavigationView {
            Form {
                Section("Appearance") {
                    Toggle("Dark Mode", isOn: $darkMode)
                        .accessibilityIdentifier("DarkModeToggle")

                    HStack {
                        Text("Font Size")
                        Slider(value: $fontSize, in: 10...30, step: 1)
                            .accessibilityIdentifier("FontSizeSlider")
                        Text("\(Int(fontSize))")
                            .frame(width: 30)
                    }
                }

                Section("Notifications") {
                    Toggle("Push Notifications", isOn: $notifications)
                        .accessibilityIdentifier("NotificationsToggle")
                }

                Section("Language") {
                    Picker("Language", selection: $language) {
                        ForEach(languages, id: \.self) { lang in
                            Text(lang).tag(lang)
                        }
                    }
                    .accessibilityIdentifier("LanguagePicker")
                }

                Section("Account") {
                    Button("Clear Cache") {}
                        .accessibilityIdentifier("ClearCacheButton")
                    Button("Delete Account") {}
                        .foregroundColor(.red)
                        .accessibilityIdentifier("DeleteAccountButton")
                }
            }
            .navigationTitle("Settings")
        }
    }
}

// MARK: - Form Tab (text inputs, steppers, date picker)

struct FormTab: View {
    @State private var name = ""
    @State private var bio = ""
    @State private var age = 25
    @State private var agreedToTerms = false
    @State private var submitted = false

    var body: some View {
        NavigationView {
            if submitted {
                VStack(spacing: 20) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 64))
                        .foregroundColor(.green)
                        .accessibilityIdentifier("FormSuccessIcon")

                    Text("Form Submitted!")
                        .font(.title)
                        .accessibilityIdentifier("FormSuccessTitle")

                    Text("Name: \(name), Age: \(age)")
                        .accessibilityIdentifier("FormSummary")

                    Button("Submit Another") {
                        submitted = false
                        name = ""
                        bio = ""
                        age = 25
                        agreedToTerms = false
                    }
                    .accessibilityIdentifier("SubmitAnotherButton")
                }
                .padding()
            } else {
                Form {
                    Section("Personal Info") {
                        TextField("Full Name", text: $name)
                            .accessibilityIdentifier("NameField")

                        TextField("Bio", text: $bio)
                            .accessibilityIdentifier("BioField")

                        Stepper("Age: \(age)", value: $age, in: 1...120)
                            .accessibilityIdentifier("AgeStepper")
                    }

                    Section("Legal") {
                        Toggle("I agree to the Terms", isOn: $agreedToTerms)
                            .accessibilityIdentifier("TermsToggle")
                    }

                    Section {
                        Button("Submit") {
                            if !name.isEmpty && agreedToTerms {
                                submitted = true
                            }
                        }
                        .disabled(name.isEmpty || !agreedToTerms)
                        .accessibilityIdentifier("SubmitFormButton")
                    }
                }
                .navigationTitle("Form")
            }
        }
    }
}
