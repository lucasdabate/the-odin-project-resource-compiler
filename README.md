# The Odin Project Resource Compiler
Easily compile The Odin Project's lessons and referenced external resources into consumable markdown files

## Usage
Run with Node to have the script fetch lesson files from [The Odin Project's Curriculum Repository](https://github.com/theodinproject/curriculum) and external resources listed in each lesson. The script will create a `compile` folder where it will output the processed files. Each course section will be contained within its own markdown file (e.g. `foundations-html_css.md`).

## Configuration
Modify the script's `ALLOWED_COURSES` array with the courses you want to fetch, using the top-level folder names in the curriculum repository.

By default, the script will compile *course sections*, but you can change the `COMPILE_COURSE` to `true` if you want the script to output a single file for the entire course.
