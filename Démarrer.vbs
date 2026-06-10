' Démarrer.vbs — lance launcher.py sans fenêtre console (pythonw.exe)
' L'agent double-clic ce fichier, le navigateur s'ouvre 2 sec plus tard sur localhost:8080.

Option Explicit
Dim WshShell, fso, scriptDir, pythonCmd, pythonwExists, pythonExists, output

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Dossier du .vbs = dossier de l'outil
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Cherche pythonw.exe (Python sans console) ou python.exe en fallback
pythonwExists = False
pythonExists = False

On Error Resume Next
Dim exec
Set exec = WshShell.Exec("cmd /c where pythonw.exe 2>nul")
If Err.Number = 0 Then
    output = exec.StdOut.ReadAll
    If output <> "" Then pythonwExists = True
End If
Err.Clear

Set exec = WshShell.Exec("cmd /c where python.exe 2>nul")
If Err.Number = 0 Then
    output = exec.StdOut.ReadAll
    If output <> "" Then pythonExists = True
End If
Err.Clear
On Error Goto 0

' Vérifie qu'on a au moins une variante de Python
If Not pythonwExists And Not pythonExists Then
    MsgBox "Python n'est pas installé sur ce poste." & vbCrLf & vbCrLf & _
           "Pour l'installer :" & vbCrLf & _
           "1. Ouvrez le centre logiciel de votre organisation (ou python.org)" & vbCrLf & _
           "2. Cherchez « Python »" & vbCrLf & _
           "3. Cliquez « Installer »" & vbCrLf & _
           "4. Une fois fini, double-cliquez a nouveau sur Demarrer.vbs", _
           vbCritical + vbOKOnly, "Audit Accessibilité"
    WScript.Quit 1
End If

' Vérifie que launcher.py et start.py sont présents
If Not fso.FileExists(scriptDir & "\launcher.py") Or Not fso.FileExists(scriptDir & "\start.py") Then
    MsgBox "Fichiers manquants : launcher.py ou start.py." & vbCrLf & vbCrLf & _
           "Le fichier Demarrer.vbs doit etre place dans le meme dossier que les autres fichiers de l'outil.", _
           vbCritical + vbOKOnly, "Audit Accessibilité"
    WScript.Quit 1
End If

' Préfère pythonw (sans console) ; fallback python.exe
If pythonwExists Then
    pythonCmd = "pythonw.exe"
Else
    pythonCmd = "python.exe"
End If

' Lance launcher.py
' 0 = fenêtre cachée, False = ne pas attendre la fin
WshShell.Run pythonCmd & " launcher.py", 0, False
