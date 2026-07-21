plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "io.github.ttalab.kepos"
  compileSdk = 35

  defaultConfig {
    applicationId = "io.github.ttalab.kepos"
    minSdk = 31
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    compose = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = "1.5.13"
  }

  sourceSets {
    getByName("main") {
      jniLibs.srcDirs("src/main/addons")
    }
  }
}

dependencies {
  implementation(project(":barekit-host"))
  implementation(platform("androidx.compose:compose-bom:2024.09.03"))
  implementation("androidx.activity:activity-compose:1.9.2")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")

  debugImplementation("androidx.compose.ui:ui-tooling")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation(platform("androidx.compose:compose-bom:2024.09.03"))
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}
