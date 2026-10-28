buildscript {
    val security = java.util.Properties().apply {
        rootProject.file("gradle/security-versions.properties").inputStream().use { load(it) }
    }
    configurations.classpath {
        resolutionStrategy.eachDependency {
            val target = when (requested.group) {
                "io.netty" -> if (requested.version?.startsWith("4.1.") == true) security.getProperty("netty") else null
                "org.bouncycastle" -> security.getProperty("bouncycastle")
                "com.google.crypto.tink" -> security.getProperty("tink")
                "com.google.protobuf" -> if (requested.version?.startsWith("3.") == true) security.getProperty("protobuf3") else null
                "org.apache.commons" -> if (requested.name == "commons-compress") security.getProperty("commons-compress") else null
                "org.apache.httpcomponents" -> if (requested.name == "httpclient") security.getProperty("httpclient4") else null
                "org.bitbucket.b_c" -> security.getProperty("jose4j")
                "org.jdom" -> security.getProperty("jdom2")
                "io.opentelemetry" -> if (requested.name in listOf("opentelemetry-api", "opentelemetry-context")) security.getProperty("opentelemetry") else null
                "com.google.guava" -> if (requested.name == "guava") security.getProperty("guava-jre") else null
                else -> null
            }
            if (target != null) { useVersion(target); because("Patched build-tool dependency; see docs/architecture/github-security.md") }
        }
    }
}
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ksp) apply false
}
allprojects {
    dependencyLocking { lockAllConfigurations() }
    // Covers internal test-platform and Kotlin configurations as well as app configurations.
    val security = java.util.Properties().apply {
        rootProject.file("gradle/security-versions.properties").inputStream().use { load(it) }
    }
    configurations.configureEach {
        resolutionStrategy.eachDependency {
            val target = when (requested.group) {
                "io.netty" -> if (requested.version?.startsWith("4.1.") == true) security.getProperty("netty") else null
                "org.bouncycastle" -> security.getProperty("bouncycastle")
                "com.google.crypto.tink" -> security.getProperty("tink")
                "com.google.protobuf" -> if (requested.version?.startsWith("3.") == true) security.getProperty("protobuf3") else null
                "org.apache.commons" -> if (requested.name == "commons-compress") security.getProperty("commons-compress") else null
                "org.apache.httpcomponents" -> if (requested.name == "httpclient") security.getProperty("httpclient4") else null
                "org.bitbucket.b_c" -> security.getProperty("jose4j")
                "org.jdom" -> security.getProperty("jdom2")
                "io.opentelemetry" -> if (requested.name in listOf("opentelemetry-api", "opentelemetry-context")) security.getProperty("opentelemetry") else null
                "com.google.guava" -> if (requested.name == "guava") {
                    if (requested.version?.endsWith("-android") == true) security.getProperty("guava-android")
                    else security.getProperty("guava-jre")
                } else null
                else -> null
            }
            if (target != null) { useVersion(target); because("Patched build-tool dependency; see docs/architecture/github-security.md") }
        }
    }
}
