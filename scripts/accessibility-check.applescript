try
	tell application "System Events"
		set _probe to name of first application process
	end tell
	return "yes"
on error
	return "no"
end try
