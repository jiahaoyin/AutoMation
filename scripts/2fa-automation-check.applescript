-- 功能性探测：宿主 App 能否通过 System Events 控制 2FA 相关进程（FollowUpUI 等）
-- 返回: yes | no:-1743:... | no:partial:... | no:0:...

on tryProbe2FAAutomation()
	tell application "System Events"
		-- 1) 基础：能否枚举 application processes
		try
			set procCount to count of application processes
			if procCount is 0 then return "no:0:no processes"
		on error errMsg number errNum
			return "no:" & errNum & ":" & errMsg
		end try

		-- 2) 能否读取 System Events 自身（自动化核心依赖）
		try
			tell process "System Events"
				set _n to name
			end tell
		on error errMsg number errNum
			if errNum is -1743 then
				return "no:-1743:Terminal not authorized to control System Events"
			end if
			return "no:" & errNum & ":" & errMsg
		end try

		-- 3) 探测 2FA 相关进程（存在时尝试读 windows/buttons）
		set targetNames to {"FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent"}
		set foundTarget to false
		repeat with p in application processes
			try
				set pName to name of p as text
			on error errMsg number errNum
				if errNum is -1743 then
					return "no:-1743:cannot read process name (Automation denied)"
				end if
				return "no:" & errNum & ":" & errMsg
			end try

			repeat with t in targetNames
				if pName contains t then
					set foundTarget to true
					try
						tell process pName
							if (count of windows) > 0 then
								set w to window 1
								try
									set _wc to count of UI elements of w
									if _wc is 0 then
										return "no:partial:2FA window found but UI elements empty (Automation likely denied)"
									end if
								on error errMsg number errNum
									if errNum is -1743 then
										return "no:-1743:cannot read 2FA window UI (Automation denied for " & pName & ")"
									end if
									return "no:" & errNum & ":" & errMsg
								end try
							end if
						end tell
					on error errMsg number errNum
						if errNum is -1743 then
							return "no:-1743:cannot control " & pName
						end if
						return "no:" & errNum & ":" & errMsg
					end try
				end if
			end repeat
		end repeat

		-- loginwindow 可能无自动化权限，不作为硬性失败
		try
			tell process "loginwindow"
				set _lw to name
			end tell
		end try

		if foundTarget then
			return "yes:2fa_process"
		end if
		return "yes:idle"
	end tell
end tryProbe2FAAutomation

return my tryProbe2FAAutomation()
