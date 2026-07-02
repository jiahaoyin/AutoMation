-- 检测宿主 App 对「系统设置」的自动化权限（可读 UI 属性 = 已授权）
-- 返回: yes | no:-1743:... | no:-25211:... | no:partial:... | no:0:...

on tryReadSystemSettingsProperty()
	tell application "System Settings" to activate
	delay 0.8
	tell application "System Events"
		tell process "System Settings"
			set frontmost to true
			delay 0.35
			if (count of windows) is 0 then
				return "no:0:no windows"
			end if
			set w to window 1
			try
				set _cls to class of w as text
				if _cls is "" then return "no:partial:window class empty (likely missing Automation permission)"
			on error errMsg number errNum
				return "no:" & errNum & ":" & errMsg
			end try
			try
				set _n to name of w
			on error errMsg number errNum
				return "no:" & errNum & ":" & errMsg
			end try
			try
				if (count of UI elements of w) > 0 then
					set _e to UI element 1 of w
					set _ec to class of _e as text
					if _ec is "" then return "no:partial:element class empty (Accessibility ok but Automation denied for System Settings)"
				end if
			on error errMsg number errNum
				return "no:" & errNum & ":" & errMsg
			end try
			return "yes"
		end tell
	end tell
end tryReadSystemSettingsProperty

return my tryReadSystemSettingsProperty()
