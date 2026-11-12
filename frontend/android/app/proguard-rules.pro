-keepattributes Signature,RuntimeVisibleAnnotations,AnnotationDefault
-keep class com.wildstring.app.data.** { *; }

# Keep release builds on the legacy BasicTextField min-size path and the
# non-pausable lazy prefetch path (see WildStringApplication). R8 would
# otherwise constant-fold the default `true` and ignore the runtime assignment.
-assumevalues class androidx.compose.foundation.ComposeFoundationFlags {
    public static boolean isBasicTextFieldMinSizeOptimizationEnabled return false;
    public static boolean isPausableCompositionInPrefetchEnabled return false;
}
