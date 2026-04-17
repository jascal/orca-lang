RUST_LIB_DIR = ../runtime-rust/target/release
FC = gfortran
FFLAGS = -Wall -Wno-unused-dummy-argument -O2 -ffree-line-length-none
LDFLAGS = -L$(RUST_LIB_DIR) -lorca_runtime_rust -lpthread -ldl -lm

UNAME := $(shell uname)
ifeq ($(UNAME), Darwin)
  LDFLAGS += -Wl,-rpath,$(abspath $(RUST_LIB_DIR))
endif

SRC = src/orca_ffi_mod.f90 src/demo_actions.f90 src/demo_main.f90
TARGET = market_sim

.PHONY: all run clean build-rust test

all: $(TARGET)

build-rust:
	cd ../runtime-rust && cargo build --release

$(TARGET): build-rust $(SRC)
	$(FC) $(FFLAGS) -o $@ $(SRC) $(LDFLAGS)

run: $(TARGET)
	./$(TARGET)

test: run

clean:
	rm -f $(TARGET) *.mod *.o
