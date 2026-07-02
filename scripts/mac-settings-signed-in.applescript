#!/usr/bin/env osascript
-- macOS 15 (Sequoia)：检测系统设置 Apple Account 是否已登录
-- Returns "yes" | "no"

on run argv
	tell application "System Events"
		if not (exists process "System Settings") then
			try
				do shell script "open 'x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings'"
				delay 2
			end try
		end if

		if not (exists process "System Settings") then return "no"

		tell process "System Settings"
			repeat with w in windows
				repeat with b in buttons of w
					set n to name of b
					if n is in {"Sign Out", "退出登录", "Sign out", "Log Out"} then return "yes"
				end repeat
				repeat with st in static texts of w
					set v to value of st
					if v contains "@" then return "yes"
				end repeat
				try
					repeat with st in static texts of scroll area 1 of group 1 of w
						set v to value of st
						if v contains "@" then return "yes"
					end repeat
				end try
			end repeat
		end tell
	end tell
	return "no"
end run
