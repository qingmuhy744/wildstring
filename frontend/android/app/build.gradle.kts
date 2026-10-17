plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}
android {
    namespace = "com.wildstring.app"
    compileSdk { version = release(36) { minorApiLevel = 1 } }
    buildToolsVersion = "36.1.0"
    defaultConfig {
        applicationId = "com.wildstring.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 14
        versionName = "0.5.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    val signingValues = listOf("ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")
        .map { providers.environmentVariable(it).orNull }
    require(signingValues.all { it == null } || signingValues.all { !it.isNullOrBlank() }) {
        "Set all four ANDROID signing environment variables, or none"
    }
    if (signingValues.all { it != null }) signingConfigs.create("release") {
        storeFile = file(signingValues[0]!!)
        storePassword = signingValues[1]
        keyAlias = signingValues[2]
        keyPassword = signingValues[3]
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    sourceSets.getByName("androidTest").assets.srcDir(rootProject.file("../../tests/fixtures/audio"))
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    lint { abortOnError = true }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
ksp { arg("room.schemaLocation", "$projectDir/schemas") }
dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material)
    implementation(libs.compose.icons)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.compose)
    implementation(libs.lifecycle.viewmodel)
    implementation(libs.media3.player)
    implementation(libs.media3.session)
    implementation(libs.media3.okhttp)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp)
    implementation(libs.coil)
    implementation(libs.coroutines)
    testImplementation(libs.junit)
    testImplementation(libs.mockwebserver)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.test)
    androidTestImplementation(libs.android.test)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.mockwebserver)
    debugImplementation(libs.compose.tooling)
    debugImplementation(libs.compose.test.manifest)
}
