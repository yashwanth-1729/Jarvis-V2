cmake_minimum_required(VERSION 3.20)
project(jarvis_sentinel LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT WIN32)
  message(FATAL_ERROR
    "jarvis-sentinel uses WASAPI, WinHTTP and RegisterHotKey directly. "
    "A POSIX port would swap audio_capture.cpp for PortAudio/PipeWire and "
    "backend_client.cpp for libcurl; nothing else is platform-specific.")
endif()

add_executable(jarvis-sentinel
  src/main.cpp
  src/audio_capture.cpp
  src/backend_client.cpp
)

target_include_directories(jarvis-sentinel PRIVATE src)

# Everything below ships with the Windows SDK — there are no third-party
# dependencies to fetch, which is what keeps this buildable on a fresh machine.
target_link_libraries(jarvis-sentinel PRIVATE
  ole32      # COM, for the WASAPI device enumerator
  winhttp    # loopback HTTP to the FastAPI backend
  user32     # RegisterHotKey and the message loop
)

if(MSVC)
  target_compile_options(jarvis-sentinel PRIVATE /W4 /permissive-)
  # WASAPI headers need a modern target; Win10 is the floor.
  target_compile_definitions(jarvis-sentinel PRIVATE _WIN32_WINNT=0x0A00 NOMINMAX)
else()
  target_compile_options(jarvis-sentinel PRIVATE -Wall -Wextra)
  target_compile_definitions(jarvis-sentinel PRIVATE _WIN32_WINNT=0x0A00 NOMINMAX)
  # MinGW: link the runtime statically so the .exe runs without the toolchain.
  target_link_options(jarvis-sentinel PRIVATE -static -static-libgcc -static-libstdc++)
endif()

set_target_properties(jarvis-sentinel PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
