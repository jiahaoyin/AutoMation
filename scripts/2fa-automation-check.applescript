-- 探测 Terminal → System Events 自动化（2FA 点「允许」依赖）
-- 返回: yes:idle | yes:2fa_process | no:-1743:... | no:partial:...
-- 注意：遍历进程时个别受保护进程可能抛 -25211，不应因此判定全局辅助功能未开

on tryProbe2FAAutomation()
	tell application "System Events"
		try
			set procCount to count of application processes
			if procCount is 0 then return "no:0:no processes"
		on error errMsg number errNum
			if errNum is -1743 then return "no:-1743:automation denied for System Events"
			return "no:" & errNum & ":" & errMsg
		end try

		try
			tell process "System Events"
				set _n to name
			end tell
		on error errMsg number errNum
			if errNum is -1743 then return "no:-1743:automation denied for System Events process"
			return "no:" & errNum & ":" & errMsg
		end try

		-- 对 Finder 做只读自动化探测（与 2FA AppleScript 路径一致）
		try
			tell process "Finder"
				set _wc to count of windows
			end tell
		on error errMsg number errNum
			if errNum is -1743 then return "no:-1743:automation denied (Finder probe)"
		end try

		set targetNames to {"FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent"}
		set foundTarget to false
		repeat with p in application processes
			set pName to ""
			try
				set pName to name of p as text
			on error errMsg number errNum
				if errNum is -1743 then return "no:-1743:cannot enumerate application processes"
				-- 个别受保护进程无法读名称（常见 -25211），跳过
			end try
			if pName is not "" then
				repeat with t in targetNames
					if pName contains t then
						set foundTarget to true
						try
							tell process pName
								set _w to count of windows
							end tell
						on error errMsg number errNum
							if errNum is -1743 then return "no:-1743:cannot control " & pName
						end try
					end if
				end repeat
			end if
		end repeat

		if foundTarget then return "yes:2fa_process"
		return "yes:idle"
	end tell
end tryProbe2FAAutomation

return my tryProbe2FAAutomation()
