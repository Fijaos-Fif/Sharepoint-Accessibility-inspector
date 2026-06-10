@echo off
REM Demarre l'outil d'audit sur Windows.
REM Si Python est installe, lance start.py + ouvre le navigateur.
REM Sinon, affiche les instructions d'installation.

cd /d "%~dp0"

cls
echo.
echo   ============================================
echo     Audit Accessibilite SharePoint
echo   ============================================
echo.

REM Verifie que python est installe (commande "python" ou "py")
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set PY_CMD=python
    goto :found
)
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set PY_CMD=py
    goto :found
)

REM Pas de Python detecte
echo   [X] Python n'est pas installe sur votre poste.
echo.
echo   Pour l'installer :
echo     1. Ouvrez le centre logiciel de votre organisation (ou python.org)
echo     2. Cherchez "Python"
echo     3. Cliquez "Installer"
echo     4. Une fois fini, double-cliquez a nouveau sur ce fichier
echo.
echo   Cette fenetre va se fermer dans 30 secondes...
timeout /t 30 >nul
exit /b 1

:found
REM Verifie que start.py est present
if not exist "start.py" (
    echo   [X] Le fichier start.py est introuvable dans ce dossier.
    echo       Assurez-vous que ce fichier .bat est dans le meme dossier que start.py.
    echo.
    pause
    exit /b 1
)

echo   [OK] Python detecte. Demarrage...
echo.
echo   Laissez cette fenetre ouverte tant que vous utilisez l'outil.
echo   Pour fermer l'outil : appuyez sur Ctrl+C ici.
echo.

REM Lance le launcher (check MAJ + start.py)
REM NOTE : sur Windows, utilisez plutot Demarrer.vbs pour un demarrage sans terminal.
REM Ce .bat reste comme backup si Demarrer.vbs ne marche pas sur votre poste.
%PY_CMD% launcher.py

echo.
echo   Cette fenetre va se fermer dans 5 secondes...
timeout /t 5 >nul
