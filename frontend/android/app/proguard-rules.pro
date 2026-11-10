-keepattributes Signature,RuntimeVisibleAnnotations,AnnotationDefault
-keep class com.wildstring.app.data.** { *; }

# Keep release builds on the legacy BasicTextField min-size path (see WildStringApplication).
-assumevalues class androidx.compose.foundation.ComposeFoundationFlags {
    public static boolean isBasicTextFieldMinSizeOptimizationEnabled return false;
}
