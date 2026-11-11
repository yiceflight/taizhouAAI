/* Recode JPEG DCT coefficients without requantization or pixel resampling.
 * Keep setjmp entirely inside C; no longjmp across Rust frames. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include <jpeglib.h>

struct report_jpeg_error { struct jpeg_error_mgr base; jmp_buf jump; };
struct report_jpeg_state {
    struct jpeg_decompress_struct src;
    struct jpeg_compress_struct dst;
    struct report_jpeg_error error;
    unsigned char *output;
    unsigned long length;
};
static void report_jpeg_fail(j_common_ptr cinfo) {
    struct report_jpeg_error *error = (struct report_jpeg_error *)cinfo->err;
    longjmp(error->jump, 1);
}
static void report_jpeg_message(j_common_ptr cinfo, int level) {
    if (level < 0) report_jpeg_fail(cinfo); /* Truncated inputs retain originals. */
}

unsigned char *report_jpeg_optimize(const unsigned char *input, unsigned long length,
                                  unsigned long *output_length) {
    struct report_jpeg_state *s = calloc(1, sizeof(*s));
    jvirt_barray_ptr *coefficients;
    jpeg_saved_marker_ptr marker;
    unsigned char *result;
    if (!s) return NULL;
    s->src.err = s->dst.err = jpeg_std_error(&s->error.base);
    s->error.base.error_exit = report_jpeg_fail;
    s->error.base.emit_message = report_jpeg_message;
    if (setjmp(s->error.jump)) {
        if (s->dst.mem) jpeg_destroy_compress(&s->dst);
        if (s->src.mem) jpeg_destroy_decompress(&s->src);
        free(s->output);
        free(s);
        return NULL;
    }
    jpeg_create_decompress(&s->src);
    jpeg_create_compress(&s->dst);
    jpeg_mem_src(&s->src, input, length);
    jpeg_save_markers(&s->src, JPEG_APP0 + 1, 0xffff);
    jpeg_save_markers(&s->src, JPEG_APP0 + 2, 0xffff);
    jpeg_read_header(&s->src, TRUE);
    if (!s->src.image_width || !s->src.image_height ||
        (double)s->src.image_width * s->src.image_height > 100000000.0)
        report_jpeg_fail((j_common_ptr)&s->src);
    coefficients = jpeg_read_coefficients(&s->src);
    jpeg_copy_critical_parameters(&s->src, &s->dst);
    s->dst.optimize_coding = TRUE;
    jpeg_simple_progression(&s->dst);
    jpeg_mem_dest(&s->dst, &s->output, &s->length);
    jpeg_write_coefficients(&s->dst, coefficients);
    for (marker = s->src.marker_list; marker; marker = marker->next) {
        /* Retain EXIF/XMP and ICC, but not MPF offsets to discarded auxiliary images. */
        if (marker->marker == JPEG_APP0 + 1 ||
            (marker->data_length >= 12 && !memcmp(marker->data, "ICC_PROFILE\0", 12)))
            jpeg_write_marker(&s->dst, marker->marker, marker->data, marker->data_length);
    }
    jpeg_finish_compress(&s->dst);
    jpeg_finish_decompress(&s->src);
    result = s->output;
    *output_length = s->length;
    jpeg_destroy_compress(&s->dst);
    jpeg_destroy_decompress(&s->src);
    free(s);
    return result;
}
void report_jpeg_free(unsigned char *buffer) { free(buffer); }
