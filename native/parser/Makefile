# Copyright © 2026 Parsa Fathi — Apache-2.0
# StreamGuard native event parser — build system.
#
# Targets:
#   all        static lib (libsgparser.a) + C ABI shared lib (libsgcapi.so)
#   test       build + run the test suite
#   sanitize   build + run tests under ASan + UBSan (must be clean)
#   tsan       build + run tests under TSan (thread-safety validation)
#   bench      build + run the benchmark (-O2), prints BENCH lines
#   format-check  clang-format dry-run if available (see note)
#   clean      remove build/

CXX ?= g++
AR ?= ar
BUILD := build
CXXFLAGS := -std=c++20 -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Iinclude
RELEASEFLAGS := $(CXXFLAGS) -O2
DEBUGFLAGS := $(CXXFLAGS) -g -O1

LIB := $(BUILD)/libsgparser.a
SOLIB := $(BUILD)/libsgcapi.so

.PHONY: all test sanitize tsan bench format-check clean

all: $(LIB) $(SOLIB)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/parser.o: src/parser.cpp include/streamguard/parser.hpp | $(BUILD)
	$(CXX) $(RELEASEFLAGS) -c $< -o $@

$(BUILD)/parser_pic.o: src/parser.cpp include/streamguard/parser.hpp | $(BUILD)
	$(CXX) $(RELEASEFLAGS) -fPIC -c $< -o $@

$(BUILD)/capi_pic.o: src/capi.cpp include/streamguard/capi.h include/streamguard/parser.hpp | $(BUILD)
	$(CXX) $(RELEASEFLAGS) -fPIC -c $< -o $@

$(LIB): $(BUILD)/parser.o
	$(AR) rcs $@ $<

$(SOLIB): $(BUILD)/capi_pic.o $(BUILD)/parser_pic.o
	$(CXX) -shared -o $@ $^

$(BUILD)/test_parser: tests/test_parser.cpp $(BUILD)/parser.o $(BUILD)/capi_pic.o
	$(CXX) $(DEBUGFLAGS) $< $(BUILD)/parser.o $(BUILD)/capi_pic.o -pthread -o $@

test: $(BUILD)/test_parser
	$(BUILD)/test_parser

$(BUILD)/test_parser_asan: tests/test_parser.cpp src/parser.cpp src/capi.cpp | $(BUILD)
	$(CXX) $(DEBUGFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer \
		$< src/parser.cpp src/capi.cpp -pthread -o $@

sanitize: $(BUILD)/test_parser_asan
	ASAN_OPTIONS=detect_leaks=1 $(BUILD)/test_parser_asan

$(BUILD)/test_parser_tsan: tests/test_parser.cpp src/parser.cpp src/capi.cpp | $(BUILD)
	$(CXX) $(DEBUGFLAGS) -fsanitize=thread $< src/parser.cpp src/capi.cpp -pthread -o $@

tsan: $(BUILD)/test_parser_tsan
	$(BUILD)/test_parser_tsan

$(BUILD)/bench_parser: bench/bench_parser.cpp src/parser.cpp | $(BUILD)
	$(CXX) $(RELEASEFLAGS) $< src/parser.cpp -o $@

bench: $(BUILD)/bench_parser
	$(BUILD)/bench_parser

# clang-format is not available in this sandbox; formatting follows the
# .clang-format style (applied when the tool exists, e.g. in CI).
format-check:
	@if command -v clang-format >/dev/null 2>&1; then \
		clang-format --dry-run --Werror include/streamguard/*.h src/*.cpp tests/*.cpp bench/*.cpp; \
	else \
		echo "note: clang-format not installed here; run 'make format-check' in CI (see .clang-format)"; \
	fi

clean:
	rm -rf $(BUILD)
